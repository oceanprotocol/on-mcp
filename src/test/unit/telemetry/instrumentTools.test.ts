import { expect } from 'chai'

import { wrapMcpServer } from '../../../telemetry/instrumentTools.js'
import type { SessionMeta } from '../../../telemetry/sessionTracker.js'
import {
  attributeKeys,
  counterValue,
  finishedSpans,
  histogramCount,
  resetSpans
} from '../../utils/hooks.js'

/** Attributes the design permits on a tool span. Anything else is a privacy regression. */
const ALLOWED_SPAN_ATTRIBUTES = [
  'tool.name',
  'tool.category',
  'session.id',
  'user.id',
  'status',
  'error.type'
]

type Harness = {
  server: { registerTool: Function; registerResource: Function; registerPrompt: Function }
  tools: Map<string, Function>
  resources: Map<string, Function>
  prompts: Map<string, Function>
  sessionMeta: SessionMeta
}

function harness(meta?: Partial<SessionMeta>): Harness {
  const tools = new Map<string, Function>()
  const resources = new Map<string, Function>()
  const prompts = new Map<string, Function>()

  const server = {
    registerTool(name: string, _config: unknown, cb: Function) {
      tools.set(name, cb)
    },
    registerResource(name: string, _uri: unknown, _config: unknown, cb: Function) {
      resources.set(name, cb)
    },
    registerPrompt(name: string, _config: unknown, cb: Function) {
      prompts.set(name, cb)
    }
  }

  const sessionMeta: SessionMeta = {
    sessionId: 'sess-1',
    userId: 'deadbeefdeadbeef',
    clientName: 'test-client',
    clientVersion: '1.0.0',
    startedAt: Date.now(),
    toolCalls: 0,
    distinctTools: new Set<string>(),
    recordToolUse(name: string) {
      this.toolCalls++
      this.distinctTools.add(name)
    },
    ...meta
  }

  wrapMcpServer(server as never, () => sessionMeta)
  return { server, tools, resources, prompts, sessionMeta }
}

const EXTRA = { sessionId: 'sess-1' }

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean }

/** Typed stand-in for a tool result — `content: []` alone trips `noImplicitAny`. */
function ok(text?: string, isError = false): ToolResult {
  return {
    content: text ? [{ type: 'text', text }] : [],
    ...(isError ? { isError: true } : {})
  }
}

describe('telemetry/instrumentTools', () => {
  beforeEach(() => resetSpans())

  it('records a successful call with name, category and status', async () => {
    const { server, tools } = harness()
    server.registerTool('get_balance', {}, () => ok())
    await tools.get('get_balance')!({}, EXTRA)

    expect(
      await counterValue('mcp.tool.calls', {
        'tool.name': 'get_balance',
        'tool.category': 'evm',
        status: 'ok'
      })
    ).to.equal(1)
    expect(
      await histogramCount('mcp.tool.duration', { 'tool.name': 'get_balance' })
    ).to.equal(1)
  })

  it('treats an `{ isError: true }` result as an error without throwing', async () => {
    // ~92 tools return this shape rather than throwing, so the result path matters more than
    // the catch path.
    const { server, tools } = harness()
    server.registerTool('search_docs', {}, () => ok('Request timed out', true))
    await tools.get('search_docs')!({ query: 'x' }, EXTRA)

    expect(
      await counterValue('mcp.tool.calls', {
        'tool.name': 'search_docs',
        status: 'error',
        'error.type': 'p2p_timeout'
      })
    ).to.equal(1)
  })

  it('records the throw path and re-throws the original error', async () => {
    const { server, tools } = harness()
    const boom = new Error('connect ECONNREFUSED 127.0.0.1:8000')
    server.registerTool('node_status', {}, () => {
      throw boom
    })

    let caught: unknown
    try {
      await tools.get('node_status')!({}, EXTRA)
    } catch (error) {
      caught = error
    }

    expect(caught).to.equal(boom)
    expect(
      await counterValue('mcp.tool.calls', {
        'tool.name': 'node_status',
        status: 'error',
        'error.type': 'network'
      })
    ).to.equal(1)
  })

  it('never puts raw arguments on the span', async () => {
    const { server, tools } = harness()
    server.registerTool('escrow_preflight', {}, () => ok())
    await tools.get('escrow_preflight')!(
      {
        privateKey: '0xdeadbeefcafebabe',
        consumerAddress: '0x1234567890abcdef1234567890abcdef12345678',
        did: 'did:op:secretsecret',
        chainId: 8453
      },
      EXTRA
    )

    const span = finishedSpans().find((s) => s.name === 'tool.escrow_preflight')
    expect(span, 'span was not created').to.not.equal(undefined)

    const keys = Object.keys(span!.attributes)
    expect(keys.filter((key) => !ALLOWED_SPAN_ATTRIBUTES.includes(key))).to.deep.equal([])

    const serialized = JSON.stringify(span!.attributes)
    expect(serialized).to.not.contain('0xdeadbeef')
    expect(serialized).to.not.contain('did:op')
    expect(serialized).to.not.contain('0x1234567890')
  })

  it('never puts raw arguments or messages on metric labels', async () => {
    // Drive both paths here rather than relying on earlier tests having run: `error.type` only
    // appears on the failure path, so a success-only run would assert a smaller key set and pass
    // vacuously.
    const { server, tools } = harness()
    server.registerTool('get_doc', {}, () => ok())
    server.registerTool('node_status', {}, (): ToolResult => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8000')
    })
    await tools.get('get_doc')!({ did: 'did:op:secret', chainId: 8453 }, EXTRA)
    try {
      await tools.get('node_status')!({ privateKey: '0xdeadbeef' }, EXTRA)
    } catch {
      // expected — the wrapper re-throws
    }

    const keys = await attributeKeys('mcp.tool.calls')
    expect(keys.sort()).to.deep.equal([
      'error.type',
      'status',
      'tool.category',
      'tool.name'
    ])
  })

  it('stamps user.id on the span but never on a metric', async () => {
    const { server, tools } = harness()
    server.registerTool('get_doc', {}, () => ok())
    await tools.get('get_doc')!({}, EXTRA)

    const span = finishedSpans().find((s) => s.name === 'tool.get_doc')
    expect(span!.attributes['user.id']).to.equal('deadbeefdeadbeef')
    // A per-user hash as a metric label is the cardinality bomb the design exists to avoid.
    expect(await attributeKeys('mcp.tool.calls')).to.not.include('user.id')
    expect(await attributeKeys('mcp.tool.duration')).to.not.include('user.id')
  })

  it('counts chain usage from a numeric chainId argument', async () => {
    const { server, tools } = harness()
    server.registerTool('get_balance', {}, () => ok())
    await tools.get('get_balance')!({ chainId: 8453 }, EXTRA)

    expect(await counterValue('mcp.chain.usage', { 'chain.id': 8453 })).to.be.at.least(1)
  })

  it('splits serviceStatus latency by the deliberate blocking wait', async () => {
    // `waitForRunning` blocks for seconds by design; mixing it into the same histogram would
    // destroy p95/p99 for ordinary status lookups.
    const { server, tools } = harness()
    server.registerTool('serviceStatus', {}, () =>
      ok('{"command":"serviceStatus","result":{"services":[]}}')
    )

    await tools.get('serviceStatus')!({ serviceId: 'a' }, EXTRA)
    await tools.get('serviceStatus')!({ serviceId: 'a', waitForRunning: true }, EXTRA)

    expect(
      await histogramCount('mcp.tool.duration', {
        'tool.name': 'serviceStatus',
        waited: false
      })
    ).to.equal(1)
    expect(
      await histogramCount('mcp.tool.duration', {
        'tool.name': 'serviceStatus',
        waited: true
      })
    ).to.equal(1)
  })

  it('feeds session call count and distinct-tool breadth', async () => {
    const { server, tools, sessionMeta } = harness()
    server.registerTool('list_topics', {}, () => ok())
    server.registerTool('get_doc', {}, () => ok())

    await tools.get('list_topics')!({}, EXTRA)
    await tools.get('list_topics')!({}, EXTRA)
    await tools.get('get_doc')!({}, EXTRA)

    expect(sessionMeta.toolCalls).to.equal(3)
    expect([...sessionMeta.distinctTools].sort()).to.deep.equal([
      'get_doc',
      'list_topics'
    ])
  })

  it('counts a failing call toward the session, so a broken session is not a bounce', async () => {
    const { server, tools, sessionMeta } = harness()
    server.registerTool('node_status', {}, (): ToolResult => {
      throw new Error('boom')
    })

    try {
      await tools.get('node_status')!({}, EXTRA)
    } catch {
      // expected — the wrapper re-throws
    }

    expect(sessionMeta.toolCalls).to.equal(1)
  })

  it('works without a session (no user id, no crash)', async () => {
    const tools = new Map<string, Function>()
    const server = {
      registerTool(name: string, _c: unknown, cb: Function) {
        tools.set(name, cb)
      },
      registerResource() {},
      registerPrompt() {}
    }
    wrapMcpServer(server as never, () => undefined)

    server.registerTool('get_doc', {}, () => ok())
    await tools.get('get_doc')!({}, {})

    const span = finishedSpans().find((s) => s.name === 'tool.get_doc')
    expect(span!.attributes['user.id']).to.equal(undefined)
  })

  it('records an uncategorized tool as unknown rather than dropping the metric', async () => {
    const { server, tools } = harness()
    server.registerTool('brand_new_undocumented_tool', {}, () => ok())
    await tools.get('brand_new_undocumented_tool')!({}, EXTRA)

    expect(
      await counterValue('mcp.tool.calls', {
        'tool.name': 'brand_new_undocumented_tool',
        'tool.category': 'unknown'
      })
    ).to.equal(1)
  })

  it('survives an argument-less tool called as cb(extra)', async () => {
    const { server, tools } = harness()
    server.registerTool('list_resources', {}, () => ok())
    await tools.get('list_resources')!(EXTRA)

    expect(
      await counterValue('mcp.tool.calls', {
        'tool.name': 'list_resources',
        status: 'ok'
      })
    ).to.equal(1)
  })

  it('counts resource reads and prompt gets', async () => {
    const { server, resources, prompts } = harness()
    server.registerResource('ocean-docs', 'ocean://docs', {}, () => ({
      contents: [] as unknown[]
    }))
    server.registerPrompt('compute-walkthrough', {}, () => ({
      messages: [] as unknown[]
    }))

    await resources.get('ocean-docs')!({})
    await prompts.get('compute-walkthrough')!({})

    expect(
      await counterValue('mcp.resource.reads', { 'resource.name': 'ocean-docs' })
    ).to.equal(1)
    expect(
      await counterValue('mcp.prompt.gets', { 'prompt.name': 'compute-walkthrough' })
    ).to.equal(1)
  })

  it('passes the original result through untouched', async () => {
    const { server, tools } = harness()
    const payload: ToolResult = { content: [{ type: 'text', text: 'hello' }] }
    server.registerTool('get_doc', {}, () => payload)
    expect(await tools.get('get_doc')!({}, EXTRA)).to.equal(payload)
  })
})
