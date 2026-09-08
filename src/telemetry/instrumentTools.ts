/**
 * Central instrumentation for tools, resources and prompts.
 *
 * Monkeypatching `registerTool` on the per-session `McpServer` is preferred over editing ~92 call
 * sites: it cannot be forgotten by a new tool, and it keeps telemetry out of the domain code
 * entirely. `wrapMcpServer` must run **between** `new McpServer()` and `registerTools()`, which is
 * what the `onCreated` hook in `createServer` exists for.
 *
 * Privacy invariant enforced here: the only span attributes ever set are `tool.name`,
 * `tool.category`, `session.id`, `user.id` and `status`. Arguments are read (for `chainId` and the
 * `image.mode`/`waited` discriminators) but **never recorded**, and error messages never leave
 * `classifyError`.
 */
import { SpanStatusCode, trace } from '@opentelemetry/api'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { categoryOf } from './categories.js'
import { classifyError } from './classifyError.js'
import { inspectResult, recordProviderLookupFailure } from './inspectResult.js'
import {
  chainUsage,
  promptGets,
  resourceReads,
  toolCalls,
  toolDuration
} from './metrics.js'
import type { SessionMeta } from './sessionTracker.js'

const tracer = trace.getTracer('ocean-mcp', '0.0.1')

export type SessionMetaProvider = () => SessionMeta | undefined

/**
 * `serviceStatus{waitForRunning:true}` blocks for up to `MAX_WAIT_FOR_RUNNING_SECONDS` by design
 * (`serviceTools.ts:842-854`). Tagging those calls keeps the deliberate wait out of the latency
 * percentiles for everything else — dashboards filter `waited="false"`.
 */
function waitedAttribute(name: string, args: any): { waited: boolean } | undefined {
  if (name !== 'serviceStatus') return undefined
  return { waited: args?.waitForRunning === true }
}

function record(
  name: string,
  category: string,
  status: 'ok' | 'error',
  durationMs: number,
  errorType: string | undefined,
  extra: Record<string, unknown> | undefined
): void {
  toolCalls.add(1, {
    'tool.name': name,
    'tool.category': category,
    status,
    ...(errorType ? { 'error.type': errorType } : {})
  })
  toolDuration.record(durationMs, {
    'tool.name': name,
    status,
    ...(extra ?? {})
  })
}

/**
 * Wrap a freshly constructed `McpServer`. Returns the same instance for convenience.
 *
 * Safe when telemetry is disabled: the OTel API hands back no-op instruments and a no-op tracer
 * without a registered provider, so the wrapper costs one closure per call and emits nothing.
 */
export function wrapMcpServer(
  server: McpServer,
  getSessionMeta: SessionMetaProvider
): McpServer {
  wrapTools(server, getSessionMeta)
  wrapResources(server)
  wrapPrompts(server)
  return server
}

function wrapTools(server: McpServer, getSessionMeta: SessionMetaProvider): void {
  const original = server.registerTool.bind(server) as (...a: any[]) => any

  server.registerTool = ((name: string, config: any, handler: any) => {
    const category = categoryOf(name)

    const wrapped = (...callArgs: any[]) => {
      // The SDK calls tool callbacks as (args, extra) or, for argument-less tools, as (extra).
      const [first, second] = callArgs
      const args = second === undefined ? undefined : first
      const extra = second ?? first

      const meta = getSessionMeta()
      meta?.recordToolUse(name)

      const start = Date.now()
      const extras = waitedAttribute(name, args)

      return tracer.startActiveSpan(`tool.${name}`, async (span) => {
        span.setAttribute('tool.name', name)
        span.setAttribute('tool.category', category)
        if (extra?.sessionId) span.setAttribute('session.id', extra.sessionId)
        // `user.id` is span-only — as a metric label it would be a cardinality bomb.
        if (meta?.userId) span.setAttribute('user.id', meta.userId)

        try {
          const res = await handler(...callArgs)
          const status = res?.isError ? 'error' : 'ok'
          const errorType = status === 'error' ? classifyError(res) : undefined

          record(name, category, status, Date.now() - start, errorType, extras)
          span.setAttribute('status', status)
          if (errorType) {
            span.setAttribute('error.type', errorType)
            span.setStatus({ code: SpanStatusCode.ERROR })
          }
          if (typeof args?.chainId === 'number') {
            chainUsage.add(1, { 'chain.id': args.chainId })
          }
          inspectResult(name, args, res)
          return res
        } catch (error) {
          const errorType = classifyError(error)
          record(name, category, 'error', Date.now() - start, errorType, extras)
          span.setAttribute('status', 'error')
          span.setAttribute('error.type', errorType)
          // Enum only. `recordException` would attach the message and stack, which can carry a
          // DID, an address, or a node URL.
          span.setStatus({ code: SpanStatusCode.ERROR })
          recordProviderLookupFailure(name)
          throw error
        } finally {
          span.end()
        }
      })
    }

    return original(name, config, wrapped)
  }) as typeof server.registerTool
}

function wrapResources(server: McpServer): void {
  const original = server.registerResource.bind(server) as (...a: any[]) => any

  server.registerResource = ((name: string, ...rest: any[]) => {
    const handler = rest.pop()
    const wrapped = (...callArgs: any[]) => {
      resourceReads.add(1, { 'resource.name': name })
      return handler(...callArgs)
    }
    return original(name, ...rest, wrapped)
  }) as typeof server.registerResource
}

function wrapPrompts(server: McpServer): void {
  const original = server.registerPrompt.bind(server) as (...a: any[]) => any

  server.registerPrompt = ((name: string, ...rest: any[]) => {
    const handler = rest.pop()
    const wrapped = (...callArgs: any[]) => {
      promptGets.add(1, { 'prompt.name': name })
      return handler(...callArgs)
    }
    return original(name, ...rest, wrapped)
  }) as typeof server.registerPrompt
}
