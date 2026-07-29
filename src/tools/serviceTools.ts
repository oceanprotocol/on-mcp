import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import { PROTOCOL_COMMANDS } from '@oceanprotocol/lib'
import type {
  ComputeEnvironment,
  ComputeResourceRequest,
  NodeStatus,
  ServiceJob,
  ServiceRestartParams,
  ServiceStartParams,
  ServiceTemplatePublic
} from '@oceanprotocol/lib'

import { NodeClient } from '../clients/nodeClient.js'
import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { stringifyError, textContent, toPrettyJson } from '../utils/format.js'
import { decodeAuthTokenAddress } from '../utils/auth.js'
import { commandResultPayload, toJsonFriendly } from './evmToolUtils.js'
import {
  DEFAULT_PARALLEL_JOBS,
  getTokenDecimals,
  runEscrowPreflight,
  serviceMinLockSeconds,
  type EscrowPreflightResult
} from './escrowPreflight.js'
import {
  nodeTargetSchema,
  p2pAuthFieldSchemas,
  parseNodeTarget,
  P2P_AUTH_SIGNING_GUIDE,
  resolveAuth,
  timeoutMs
} from './p2pSchemas.js'
import {
  SERVICE_AUTH_NOTE,
  SERVICE_OVERVIEW_GUIDE,
  SERVICE_PAYMENT_GUIDE,
  SERVICE_POLLING_GUIDE,
  SERVICE_RESTART_SEMANTICS_GUIDE,
  SERVICE_STATUS_LABELS,
  SERVICE_USERDATA_GUIDE,
  serviceContainerSpecSchema,
  serviceIdSchema,
  serviceListFiltersSchema,
  servicePaymentSchema,
  serviceResourcesSchema
} from './serviceSchemas.js'
import {
  availableFor,
  buildServicePaymentInfo,
  decorateServiceJob,
  describeUserDataKeys,
  estimateServiceCost as estimateCost,
  parseUserData,
  resolveServiceResources,
  resourceMinimumWarnings,
  resourceShortfallReason,
  templateToServiceStartArgs,
  toRawAmount,
  type ResourceRequirement
} from './serviceCost.js'

type Params = {
  server: McpServer
  nodeClient: NodeClient
  /** When provided, serviceStart/serviceExtend run an on-chain escrow gate before the call. */
  evmRegistry?: EvmProviderRegistry
}

/** Bounded convenience wait inside serviceStatus — kept well inside MCP client timeouts. */
const MAX_WAIT_FOR_RUNNING_SECONDS = 120
const WAIT_POLL_INTERVAL_MS = 5000
/** Default log window. Without it the node streams the container's whole history. */
const DEFAULT_LOG_SINCE = '5m'
const DEFAULT_LOG_MAX_BYTES = 256 * 1024

function errorPayload(message: string) {
  return { ...textContent(message), isError: true as const }
}

function structuredError(command: string, body: Record<string, unknown>) {
  return {
    ...textContent(toPrettyJson({ command, ...(toJsonFriendly(body) as object) })),
    isError: true as const
  }
}

/** Payer address from the auth inputs, without ever needing a private key. */
function resolvePayerFromAuth(args: {
  authToken?: string
  completeSignature?: { consumerAddress: string }
}): string | undefined {
  try {
    if (args.authToken) return decodeAuthTokenAddress(args.authToken)
    if (args.completeSignature?.consumerAddress)
      return args.completeSignature.consumerAddress
  } catch {
    return undefined
  }
  return undefined
}

async function findEnvironment(
  nodeClient: NodeClient,
  node: ReturnType<typeof parseNodeTarget>,
  timeout: number,
  environmentId: string
): Promise<{ env?: ComputeEnvironment; all: ComputeEnvironment[] }> {
  const all = await nodeClient.getComputeEnvironments<ComputeEnvironment[]>(node, timeout)
  return { env: (all ?? []).find((e) => e.id === environmentId), all: all ?? [] }
}

type CostResolution = {
  costHuman: number
  feeToken: string
  rawAmount: string
  decimals: number
  minutesBilled: number
  effectiveDurationSeconds: number
  resources: ComputeResourceRequest[]
  unpricedResourceIds: string[]
}

/**
 * Shared cost path: node's arithmetic (with the minJobDuration floor) + raw-unit conversion.
 * Throws with an actionable message when the env has no schedule for `(chainId, token)`.
 */
async function resolveCost(params: {
  evmRegistry: EvmProviderRegistry
  env: ComputeEnvironment
  chainId: number
  token: string
  resources: ComputeResourceRequest[]
  durationSeconds: number
  tokenDecimals?: number
}): Promise<CostResolution> {
  const { evmRegistry, env, chainId, token, resources, durationSeconds } = params
  const estimate = estimateCost(env, chainId, token, resources, durationSeconds)
  if (!estimate) {
    const advertised = Object.entries(env.fees ?? {})
      .map(([cid, fees]) => `${cid}: ${fees.map((f) => f.feeToken).join(', ')}`)
      .join(' | ')
    throw new Error(
      `Environment "${env.id}" advertises no fee schedule for token ${token} on chain ${chainId}, ` +
        `so SERVICE_START would fail with "No pricing configured". Advertised schedules — ` +
        `${advertised || '(none)'}. Use one of those tokens verbatim (the node matches case-sensitively).`
    )
  }
  const decimals =
    params.tokenDecimals ??
    (await getTokenDecimals(evmRegistry, chainId, estimate.feeToken))
  return {
    costHuman: estimate.costHuman,
    feeToken: estimate.feeToken,
    rawAmount: toRawAmount(estimate.costHuman, decimals),
    decimals,
    minutesBilled: estimate.minutesBilled,
    effectiveDurationSeconds: estimate.effectiveDurationSeconds,
    resources: estimate.resources,
    unpricedResourceIds: estimate.unpricedResourceIds
  }
}

/**
 * Best-effort on-chain escrow gate for the paid service calls, modelled on `escrowPreflightGate`
 * in p2pProviderTools. Blocks with an `isError` payload when escrow cannot back the service;
 * returns `undefined` to proceed.
 *
 * "Best-effort" is deliberate and matches the compute path: **any** internal failure (no
 * evmRegistry, RPC hiccup, unresolved payer, no fee schedule) proceeds and lets the node decide,
 * rather than false-blocking. The one case it must not get wrong is a zero cost — there we skip
 * the gate outright instead of constructing a `payment` that `paymentSchema` rejects and
 * mis-reporting a schema error as an escrow problem.
 *
 * Exported (with an injectable `runPreflight`) so the decision logic can be unit-tested without
 * an RPC endpoint; production callers always take the default.
 */
export async function serviceEscrowGate(params: {
  command: string
  nodeClient: NodeClient
  evmRegistry: EvmProviderRegistry | undefined
  node: ReturnType<typeof parseNodeTarget>
  timeout: number
  args: {
    authToken?: string
    completeSignature?: { consumerAddress: string }
    skipEscrowPreflight?: boolean
    parallelJobs?: number
  }
  env: ComputeEnvironment
  chainId: number
  token: string
  resources: ComputeResourceRequest[]
  durationSeconds: number
  runPreflight?: typeof runEscrowPreflight
}): Promise<ReturnType<typeof structuredError> | undefined> {
  const { command, nodeClient, evmRegistry, node, timeout, args, env } = params
  const runPreflight = params.runPreflight ?? runEscrowPreflight
  if (!evmRegistry || args.skipEscrowPreflight === true) return undefined

  const payer = resolvePayerFromAuth(args)
  if (!payer) return undefined

  let preflight: EscrowPreflightResult
  try {
    const cost = await resolveCost({
      evmRegistry,
      env,
      chainId: params.chainId,
      token: params.token,
      resources: params.resources,
      durationSeconds: params.durationSeconds
    })
    const status = await nodeClient.status<NodeStatus>(node, timeout)
    const built = buildServicePaymentInfo({
      escrowAddressByChain: status?.escrowAddress,
      payee: env.consumerAddress,
      chainId: params.chainId,
      feeToken: cost.feeToken,
      rawAmount: cost.rawAmount,
      durationSeconds: params.durationSeconds
    })
    // Free service: nothing to lock, so there is nothing to gate on.
    if (!built.escrowRequired) return undefined

    preflight = await runPreflight({
      evmRegistry,
      payer,
      payment: built.payment,
      maxJobDuration: params.durationSeconds,
      parallelJobs: args.parallelJobs ?? DEFAULT_PARALLEL_JOBS
    })
  } catch {
    return undefined
  }

  if (preflight.canStartThisJob) return undefined
  return structuredError(command, {
    error: 'escrow_preflight_failed',
    message:
      'Escrow is not funded/authorized for this service, so it would fail asynchronously at the ' +
      'Locking step after already returning a serviceId. Resolve it (dashboard Manage escrow, or ' +
      'escrow_preflight with a privateKey for auto-fix) then retry. Pass skipEscrowPreflight=true ' +
      'to bypass this gate. Note the amount below is an *estimate* — there is no server-side quote.',
    preflight
  })
}

/** Summary of one env for the discovery tools. */
function describeServiceEnv(
  env: ComputeEnvironment,
  opts: { chainId?: number; token?: string; requirements?: ResourceRequirement[] }
) {
  const advertisesServices = env.features?.services !== false
  const shortfall = resourceShortfallReason(env, opts.requirements)

  const feeSchedules = env.fees ?? {}
  let feeTokens: string[] | undefined
  let hasSchedule: boolean | undefined
  if (opts.chainId !== undefined) {
    feeTokens = (feeSchedules[String(opts.chainId)] ?? []).map((f) => f.feeToken)
    hasSchedule =
      opts.token === undefined
        ? feeTokens.length > 0
        : feeTokens.some((t) => t.toLowerCase() === opts.token!.toLowerCase())
  }

  const reasons: string[] = []
  if (!advertisesServices) reasons.push('env sets features.services = false')
  if (hasSchedule === false) {
    reasons.push(
      opts.token
        ? `no fee schedule for token ${opts.token} on chain ${opts.chainId} (SERVICE_START would 400 "No pricing configured")`
        : `no fee schedule at all for chain ${opts.chainId}`
    )
  }
  if (shortfall) reasons.push(`insufficient free capacity — ${shortfall}`)

  return {
    id: env.id,
    description: env.description,
    /** "Advertised as service-capable" — the node's SERVICE_START is authoritative. */
    eligible: reasons.length === 0,
    mismatchReason: reasons.length ? reasons.join('; ') : undefined,
    advertisesServices,
    /** features.computeJobs, surfaced for free by the same object. */
    advertisesComputeJobs: env.features?.computeJobs !== false,
    /** Escrow payee for this env's services. */
    consumerAddress: env.consumerAddress,
    minJobDuration: env.minJobDuration,
    maxJobDuration: env.maxJobDuration,
    ...(opts.chainId !== undefined ? { feeTokensOnChain: feeTokens } : {}),
    freeResources: (env.resources ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      type: r.type,
      free: (r.total ?? 0) - (r.inUse ?? 0),
      total: r.total,
      min: r.min,
      max: r.max
    })),
    hasAccessRestrictions: Boolean(
      env.access?.addresses?.length || env.access?.accessLists
    ),
    ...(opts.requirements?.length
      ? {
          requestedFits: shortfall === null,
          requestedResourceCheck: (opts.requirements ?? []).map((req) => ({
            requirement:
              req.id ?? `${req.kind ?? 'resource'}${req.type ? `/${req.type}` : ''}`,
            need: req.min,
            free: availableFor(env, req)
          }))
        }
      : {})
  }
}

/** `resources` input (id/amount) → the requirement shape the capacity checks use. */
function toRequirements(
  resources: ComputeResourceRequest[] | undefined
): ResourceRequirement[] | undefined {
  if (!resources?.length) return undefined
  return resources.map((r) => ({ id: r.id, min: r.amount }))
}

const SERVICE_ADVISORY_NOTE = `**\`features.services\` is an advertisement, not a guarantee.** It defaults to \`true\` node-side, and the node's start path never re-checks that \`serviceOnDemand\` was actually configured — so \`eligible: true\` means "advertised as service-capable, with pricing and capacity that fit". The node's \`${PROTOCOL_COMMANDS.SERVICE_START}\` is authoritative. An **empty template list proves nothing either way** (the node just reads a folder), so never report "no templates" as "services unavailable".`

export function registerServiceTools({ server, nodeClient, evmRegistry }: Params): void {
  // ── Discovery ────────────────────────────────────────────────────────────

  server.registerTool(
    'findServiceEnvironments',
    {
      title: 'Services: find service-capable compute environments on a node',
      description: `Lists a node's compute environments and reports which can actually host a **service** (\`getComputeEnvironments\` → \`features.services !== false\`, plus the practical filters that turn "advertised" into "startable"). **No auth.**

Beyond the feature flag it checks:
1. a **fee schedule** exists for your \`(chainId, token)\` — without one \`${PROTOCOL_COMMANDS.SERVICE_START}\` returns \`400 No pricing configured\`;
2. **free capacity** (\`total - inUse\`) per resource;
3. your requested \`resources\` fit — reported as \`gpu: need 2, have 1\`.

Every env comes back with \`eligible\` and a human \`mismatchReason\`, so you can explain *why* one was skipped rather than silently narrowing. \`consumerAddress\` is the escrow **payee** for that env.

${SERVICE_ADVISORY_NOTE}

${SERVICE_OVERVIEW_GUIDE}`,
      inputSchema: {
        ...nodeTargetSchema,
        chainId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Chain you intend to pay on — enables the fee-schedule check.'),
        token: z
          .string()
          .optional()
          .describe(
            'Fee token address you intend to pay with (matched case-insensitively here).'
          ),
        resources: serviceResourcesSchema
      }
    },
    async ({ nodeId, multiaddress, timeout, chainId, token, resources }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const envs = await nodeClient.getComputeEnvironments<ComputeEnvironment[]>(
          node,
          timeoutMs(timeout)
        )
        const requirements = toRequirements(resources)
        const described = (envs ?? []).map((env) =>
          describeServiceEnv(env, { chainId, token, requirements })
        )
        return commandResultPayload('findServiceEnvironments', {
          environments: described,
          eligibleCount: described.filter((e) => e.eligible).length,
          note:
            'eligible = advertised as service-capable AND priced AND has capacity. The node ' +
            'is authoritative; see the advisory note in the tool description. Service duration ' +
            'is additionally capped by serviceOnDemand.maxDurationSeconds (node config, default ' +
            '86400s) which is NOT advertised here.'
        })
      } catch (error) {
        return errorPayload(stringifyError(error))
      }
    }
  )

  server.registerTool(
    'findServiceNodes',
    {
      title: 'Services: find nodes that can host a service',
      description: `Fans \`findServiceEnvironments\` out across several peers and returns those with at least one service-capable environment. **No auth.**

Use this to answer "which node can run my service?". #1408 adds **no DHT advertise string for services**, so \`find_provider\` cannot answer it — candidate peers must come from \`list_discovered_peers\`, \`incentives_list_nodes\` / \`incentives_list_envs\`, or an explicit list. Pass \`peerIds\` when you already have candidates; otherwise this uses the local peer store.

Unreachable or non-service peers are **skipped, not failed** — the call always returns whatever it could reach, with per-peer errors listed under \`skipped\`. Only some nodes have services enabled today (more are rolling out), which is exactly why this is a fan-out and not a hardcoded list.

${SERVICE_ADVISORY_NOTE}`,
      inputSchema: {
        peerIds: z
          .array(z.string())
          .optional()
          .describe(
            'Candidate peer ids. Omit to use the local peer store (list_discovered_peers).'
          ),
        chainId: z.number().int().positive().optional(),
        token: z.string().optional(),
        resources: serviceResourcesSchema,
        maxPeers: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Cap on peers probed (default 12). Probing is bounded and concurrent.'
          ),
        timeout: z
          .number()
          .optional()
          .describe('Per-peer timeout in **seconds** (default 10).')
      }
    },
    async ({ peerIds, chainId, token, resources, maxPeers, timeout }) => {
      try {
        let candidates = peerIds ?? []
        if (!candidates.length) {
          const discovered = await nodeClient.listDiscoveredPeers()
          candidates = (discovered ?? []).map((p) => p.peerId)
        }
        const limit = maxPeers ?? 12
        const probed = candidates.slice(0, limit)
        const requirements = toRequirements(resources)
        const perPeerTimeout = timeoutMs(timeout)

        const results = await Promise.all(
          probed.map(async (peerId) => {
            try {
              const envs = await nodeClient.getComputeEnvironments<ComputeEnvironment[]>(
                parseNodeTarget(peerId, undefined),
                perPeerTimeout
              )
              const described = (envs ?? [])
                .map((env) => describeServiceEnv(env, { chainId, token, requirements }))
                .filter((e) => e.advertisesServices)
              return { peerId, serviceEnvs: described }
            } catch (error) {
              return { peerId, error: stringifyError(error) }
            }
          })
        )

        const reached = results.filter(
          (
            r
          ): r is {
            peerId: string
            serviceEnvs: ReturnType<typeof describeServiceEnv>[]
          } => 'serviceEnvs' in r
        )
        return commandResultPayload('findServiceNodes', {
          nodes: reached.filter((r) => r.serviceEnvs.length > 0),
          reachedWithoutServiceEnvs: reached
            .filter((r) => r.serviceEnvs.length === 0)
            .map((r) => r.peerId),
          skipped: results.filter((r) => 'error' in r),
          probedCount: probed.length,
          ...(candidates.length > probed.length
            ? {
                truncated: `Only the first ${probed.length} of ${candidates.length} candidate peers were probed (maxPeers). Raise maxPeers or pass peerIds explicitly to cover the rest.`
              }
            : {})
        })
      } catch (error) {
        return errorPayload(stringifyError(error))
      }
    }
  )

  server.registerTool(
    'getServiceTemplates',
    {
      title: "Services: list a node operator's service templates",
      description: `Returns the node's service template catalogue (\`${PROTOCOL_COMMANDS.SERVICE_GET_TEMPLATES}\`). **No auth.**

**These are informational.** The catalogue is **curated by the node owner** — a suggested, explicitly **non-exhaustive** set of services known to run there. It is **not an allow-list**, and there is **no \`templateId\` parameter on \`serviceStart\`**: run one as-is, or use it as inspiration for your own image. Either way you pass the container spec to \`serviceStart\` explicitly.

⚠️ **Field-rename trap.** A template's \`command\`/\`entrypoint\` are **not** valid \`serviceStart\` arguments — there they are \`dockerCmd\`/\`dockerEntrypoint\`. Copied verbatim they are **silently dropped** and the container runs its image default. So each entry here comes with a paste-ready **\`serviceStartArgs\`** projection that is already renamed; use that rather than hand-copying from \`template\`.

Two distinct env-var families, do not mix them:
- **\`userDataKeys\`** (from \`userConfigurableEnvVars\`) — **yours** to fill in via \`serviceStart\`'s \`userData\`.
- **\`operatorEnvVarKeys\`** (from \`envVarKeys\`) — the **operator's**; keys are exposed, values never are. Do **not** send these back.

An **empty list is normal** on a fully working node (the node just reads a folder) — never report it as "services unavailable", and never tell a user their image is unsupported because it is not listed.`,
      inputSchema: {
        ...nodeTargetSchema,
        chainId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional chain filter passed through to the node.')
      }
    },
    async ({ nodeId, multiaddress, timeout, chainId }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const templates: ServiceTemplatePublic[] = await nodeClient.getServiceTemplates(
          node,
          timeoutMs(timeout),
          chainId
        )
        return commandResultPayload('getServiceTemplates', {
          count: templates?.length ?? 0,
          templates: (templates ?? []).map(templateToServiceStartArgs),
          note:
            'An empty catalogue is the normal state on a working node and says nothing about ' +
            'whether services are available. Templates are suggestions, not an allow-list — ' +
            'there is no templateId on serviceStart.'
        })
      } catch (error) {
        return errorPayload(stringifyError(error))
      }
    }
  )

  // ── Cost ─────────────────────────────────────────────────────────────────

  server.registerTool(
    'estimateServiceCost',
    {
      title: 'Services: estimate cost and build an escrow payment object',
      description: `Client-side cost **estimate** for a service, plus a ready-made \`payment\` object you can hand straight to **escrow_preflight**. **No auth**, no chain writes.

**There is no server-side quote for services** (no \`initializeService\`), so this reimplements ocean-node's own arithmetic — \`price(resourceId) × amount × ceil(effectiveDuration / 60)\`, where \`effectiveDuration = max(duration, env.minJobDuration)\`. The node computes its own figure at start time and that one is authoritative: never tell a user a service "will cost X".

Returns \`payment{escrowAddress, chainId, payee, token, amount, minLockSeconds}\` with \`amount\` as a **decimal string** of raw base units (an 18-decimal amount exceeds \`Number.MAX_SAFE_INTEGER\`). Feed it to \`escrow_preflight\` with \`maxJobDuration = duration\`.

**Free service?** If the estimate is 0 you get \`escrowRequired: false\` and **no** \`payment\` — skip \`escrow_preflight\` entirely. A 0 usually means the resource ids you asked for are not priced by this env; check \`unpricedResourceIds\`, because the node prices an unknown id at 0 **silently**.

For **extend**, price off the *stored* job: take \`resources\` and \`environment\` from \`serviceStatus\` (never re-derive them from env defaults) and pass \`duration = additionalDuration\` — the node bills the additional window alone.

${SERVICE_PAYMENT_GUIDE}`,
      inputSchema: {
        ...nodeTargetSchema,
        environment: z.string().describe('Env id from findServiceEnvironments.'),
        duration: z
          .number()
          .int()
          .positive()
          .describe(
            'Service run time in seconds (or `additionalDuration` when estimating an extend).'
          ),
        chainId: z.number().int().positive(),
        token: z
          .string()
          .describe(
            "Fee token address. Matched case-insensitively here; the returned `payment.token` echoes the env's own spelling — send that one on."
          ),
        resources: serviceResourcesSchema,
        tokenDecimals: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Override ERC-20 decimals. Only needed when no EVM RPC is configured for this chain.'
          )
      }
    },
    async ({
      nodeId,
      multiaddress,
      timeout,
      environment,
      duration,
      chainId,
      token,
      resources,
      tokenDecimals
    }) => {
      try {
        if (!evmRegistry && tokenDecimals === undefined) {
          return errorPayload(
            'No EVM registry configured on this MCP server, so token decimals cannot be read. ' +
              'Pass `tokenDecimals` explicitly to get a raw amount.'
          )
        }
        const node = parseNodeTarget(nodeId, multiaddress)
        const ms = timeoutMs(timeout)
        const { env, all } = await findEnvironment(nodeClient, node, ms, environment)
        if (!env) {
          return errorPayload(
            `Environment "${environment}" not found on this node. Available: ` +
              `${all.map((e) => e.id).join(', ') || '(none)'}.`
          )
        }

        const requested = resolveServiceResources(resources, env)
        const cost = await resolveCost({
          evmRegistry: evmRegistry as EvmProviderRegistry,
          env,
          chainId,
          token,
          resources: requested,
          durationSeconds: duration,
          tokenDecimals
        })

        const status = await nodeClient.status<NodeStatus>(node, ms)
        const built = buildServicePaymentInfo({
          escrowAddressByChain: status?.escrowAddress,
          payee: env.consumerAddress,
          chainId,
          feeToken: cost.feeToken,
          rawAmount: cost.rawAmount,
          durationSeconds: duration
        })

        const warnings: string[] = []
        if (cost.effectiveDurationSeconds !== duration) {
          warnings.push(
            `Billed duration was clamped up to the env's minJobDuration: requested ${duration}s, ` +
              `billed ${cost.effectiveDurationSeconds}s (${cost.minutesBilled} minute(s)).`
          )
        }
        if (cost.unpricedResourceIds.length) {
          warnings.push(
            `Resource id(s) ${cost.unpricedResourceIds.join(', ')} have no price in this env's ` +
              `schedule and are billed at 0 — the node does this silently, so check for a typo ` +
              `against the env's advertised resource ids.`
          )
        }
        warnings.push(...resourceMinimumWarnings(env, cost.resources))

        return commandResultPayload('estimateServiceCost', {
          isEstimate: true,
          environment: env.id,
          payee: env.consumerAddress,
          estimatedCostHuman: cost.costHuman,
          estimatedCostRaw: cost.rawAmount,
          token: cost.feeToken,
          tokenDecimals: cost.decimals,
          minutesBilled: cost.minutesBilled,
          requestedDurationSeconds: duration,
          billedDurationSeconds: cost.effectiveDurationSeconds,
          resources: cost.resources,
          ...built,
          ...(warnings.length ? { warnings } : {}),
          nextStep: built.escrowRequired
            ? `escrow_preflight with this payment object and maxJobDuration=${duration}, then serviceStart.`
            : 'No escrow needed — go straight to serviceStart.',
          denominationHint:
            `Do not format estimatedCostRaw yourself — call get_erc20_token_info(chainId=${chainId}, ` +
            `tokenAddress=${cost.feeToken}, rawAmount=${cost.rawAmount}) and show the symbol.`
        })
      } catch (error) {
        return errorPayload(stringifyError(error))
      }
    }
  )

  // ── Write path ───────────────────────────────────────────────────────────

  server.registerTool(
    'serviceStart',
    {
      title: 'Services: start a long-running container service',
      description: `Starts a **paid, long-running container service** (\`${PROTOCOL_COMMANDS.SERVICE_START}\`). Requires auth.

**This returns before the service is up.** You get a \`serviceId\` and status \`Starting (10)\` immediately; escrow lock → image pull/build + vulnerability scan → claim → port allocation → container start all happen in the background. **Then poll \`serviceStatus\`.**

Runs the same best-effort **escrow gate** as \`computeStart\`: it estimates the cost, checks funds + the node authorization on-chain, and refuses to start when escrow cannot back the service (bypass with \`skipEscrowPreflight: true\`). This matters more here than for compute — a doomed service start still returns a \`serviceId\` and then dies asynchronously at \`Locking\`, which is far worse than a synchronous refusal.

${SERVICE_OVERVIEW_GUIDE}

${SERVICE_PAYMENT_GUIDE}

${SERVICE_POLLING_GUIDE}

${SERVICE_USERDATA_GUIDE}

${SERVICE_AUTH_NOTE}

${P2P_AUTH_SIGNING_GUIDE}

**protocolCommand:** \`${PROTOCOL_COMMANDS.SERVICE_START}\`. **Returns:** one \`ServiceJob\`, decorated with \`statusLabel\` and next-step guidance.`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        environment: z
          .string()
          .describe('Env id — must be service-capable (findServiceEnvironments).'),
        ...serviceContainerSpecSchema,
        exposedPorts: z
          .array(z.number().int())
          .optional()
          .describe(
            'In-container ports to publish. **Must be ≥ 1024** — the container drops all capabilities (no NET_BIND_SERVICE) and cannot bind privileged ports.'
          ),
        resources: serviceResourcesSchema,
        duration: z
          .number()
          .int()
          .positive()
          .describe(
            "Seconds to keep the service up and pay for. Capped by the node's serviceOnDemand.maxDurationSeconds (default 86400s, not advertised). The resource reservation is held for this whole window even if you stop early."
          ),
        payment: servicePaymentSchema,
        parallelJobs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Escrow preflight: concurrent services to provision authorization for (default ${DEFAULT_PARALLEL_JOBS}).`
          ),
        skipEscrowPreflight: z
          .boolean()
          .optional()
          .describe('Skip the on-chain escrow gate (use when already provisioned).')
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const ms = timeoutMs(args.timeout)

        const imageModes = [args.tag, args.checksum, args.dockerfile].filter(
          Boolean
        ).length
        if (imageModes > 1) {
          return errorPayload(
            'Provide at most one of `tag`, `checksum`, `dockerfile` — they are mutually exclusive image modes.'
          )
        }
        const lowPorts = (args.exposedPorts ?? []).filter((p) => p < 1024)
        if (lowPorts.length) {
          return errorPayload(
            `In-container port(s) ${lowPorts.join(', ')} are below 1024. The container runs with ` +
              `CapDrop ALL (no NET_BIND_SERVICE) and cannot bind them — the service would start ` +
              `and be charged for, then fail to serve. Reconfigure the app to listen on a port ≥ 1024.`
          )
        }

        const { env, all } = await findEnvironment(nodeClient, node, ms, args.environment)
        if (!env) {
          return errorPayload(
            `Environment "${args.environment}" not found on this node. Available: ` +
              `${all.map((e) => e.id).join(', ') || '(none)'}.`
          )
        }
        if (env.features?.services === false) {
          return errorPayload(
            `Environment "${env.id}" sets features.services = false — SERVICE_START will return 403. ` +
              `Use findServiceEnvironments to pick a service-capable env.`
          )
        }

        const userDataCheck = parseUserData(args.userData)
        const resources = resolveServiceResources(args.resources, env)

        const gate = await serviceEscrowGate({
          command: 'serviceStart',
          nodeClient,
          evmRegistry,
          node,
          timeout: ms,
          args,
          env,
          chainId: args.payment.chainId,
          token: args.payment.token,
          resources,
          durationSeconds: args.duration
        })
        if (gate) return gate

        const params: ServiceStartParams = {
          environment: args.environment,
          image: args.image as string,
          ...(args.tag ? { tag: args.tag } : {}),
          ...(args.checksum ? { checksum: args.checksum } : {}),
          ...(args.dockerfile ? { dockerfile: args.dockerfile } : {}),
          ...(args.additionalDockerFiles
            ? { additionalDockerFiles: args.additionalDockerFiles }
            : {}),
          ...(args.exposedPorts ? { exposedPorts: args.exposedPorts } : {}),
          ...(args.dockerCmd ? { dockerCmd: args.dockerCmd } : {}),
          ...(args.dockerEntrypoint ? { dockerEntrypoint: args.dockerEntrypoint } : {}),
          ...(args.userData ? { userData: args.userData } : {}),
          // Send the SAME resolved resources the escrow gate priced, so the estimate and the
          // request describe the same service. (The node still applies its own per-resource
          // minimums on top — see resourceMinimumWarnings.)
          ...(resources.length ? { resources } : {}),
          duration: args.duration,
          payment: args.payment
        }

        const started = await nodeClient.serviceStart(node, auth, params, ms)
        const jobs = (started ?? []).map(decorateServiceJob)
        return commandResultPayload('serviceStart', {
          services: jobs,
          // Keys only — userData values must never appear in a response.
          userDataKeys: describeUserDataKeys(args.userData),
          ...(userDataCheck.warnings.length
            ? { userDataWarnings: userDataCheck.warnings }
            : {}),
          resourcesRequested: resources,
          nextStep:
            'The service is NOT up yet. Poll serviceStatus with this serviceId every ~5-10s ' +
            'until status 40 (Running), without asking the user between polls. Then report ' +
            'endpoints[].url.'
        })
      } catch (error) {
        return errorPayload(stringifyError(error))
      }
    }
  )

  server.registerTool(
    'serviceStatus',
    {
      title: "Services: get your services' status and endpoints",
      description: `Owner-scoped status for one service or all of yours (\`${PROTOCOL_COMMANDS.SERVICE_GET_STATUS}\`). Requires auth. Omit \`serviceId\` for every service you own on this node.

Decorates each job with a human \`statusLabel\` (including \`45 Restarting\`), \`expiresAtIso\`, \`isTerminal\` and \`paymentClaimed\` (a precondition for restart).

\`userData\` is always stripped by the node, so you cannot read a value back — to change one you must re-supply the whole spec via a RESPEC restart.

${SERVICE_POLLING_GUIDE}

${SERVICE_AUTH_NOTE}

${P2P_AUTH_SIGNING_GUIDE}`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        serviceId: serviceIdSchema.optional(),
        waitForRunning: z
          .boolean()
          .optional()
          .describe(
            `Convenience: poll internally until Running or a terminal status, up to ${MAX_WAIT_FOR_RUNNING_SECONDS}s. Bounded on purpose — image pulls can take far longer than any MCP client timeout, so polling in the conversation remains the documented path.`
          ),
        waitTimeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Seconds to wait when waitForRunning is set (default and hard cap ${MAX_WAIT_FOR_RUNNING_SECONDS}).`
          )
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const ms = timeoutMs(args.timeout)

        const fetchJobs = () =>
          nodeClient.getServiceStatus(node, auth, ms, args.serviceId)

        let jobs: ServiceJob[] = await fetchJobs()
        let waitedMs = 0
        let waitTimedOut = false

        if (args.waitForRunning && args.serviceId) {
          const budgetMs =
            Math.min(
              args.waitTimeout ?? MAX_WAIT_FOR_RUNNING_SECONDS,
              MAX_WAIT_FOR_RUNNING_SECONDS
            ) * 1000
          // 40 Running and 45 Restarting are both "settled enough to report"; anything
          // terminal ends the wait too. 50 Stopping is in flight, so it keeps waiting.
          const settled = (j?: ServiceJob) =>
            j !== undefined && (j.status === 40 || decorateServiceJob(j).isTerminal)
          let current = jobs.find((j) => j.serviceId === args.serviceId)
          while (!settled(current) && waitedMs < budgetMs) {
            await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS))
            waitedMs += WAIT_POLL_INTERVAL_MS
            jobs = await fetchJobs()
            current = jobs.find((j) => j.serviceId === args.serviceId)
          }
          waitTimedOut = !settled(current)
        }

        const decorated = (jobs ?? []).map(decorateServiceJob)
        return commandResultPayload('serviceStatus', {
          services: decorated,
          statusLegend: SERVICE_STATUS_LABELS,
          ...(args.waitForRunning
            ? {
                waitedSeconds: Math.round(waitedMs / 1000),
                waitTimedOut,
                ...(waitTimedOut
                  ? {
                      waitNote:
                        'Still in flight after the bounded wait — this is normal for an image ' +
                        'pull or build. Keep calling serviceStatus; do not treat it as a failure.'
                    }
                  : {})
              }
            : {})
        })
      } catch (error) {
        return errorPayload(stringifyError(error))
      }
    }
  )

  server.registerTool(
    'getServices',
    {
      title: 'Services: list services on a node (NODE-WIDE, not just yours)',
      description: `Lists services on the node (\`${PROTOCOL_COMMANDS.SERVICE_LIST}\`). Requires auth.

🚩 **This is authenticated but NOT owner-scoped.** Any consumer identity sees **every owner's** services. **Do not present these as the user's own services** — use \`serviceStatus\` for that. Listings are sanitized: no \`userData\`, no \`dockerCmd\`/\`dockerEntrypoint\`, no Dockerfile.

With no filters the node returns only services **currently holding a resource reservation** — what actually counts against the shared pools. Pass \`includeAllStatuses\` or a specific \`status\` to see beyond that (e.g. \`75\` Expired). \`updatedSince\` is the **incremental-sync cursor**: it returns every status changed at/after that moment, so feed back the highest \`updatedAt\` you have seen.

${SERVICE_AUTH_NOTE}

${P2P_AUTH_SIGNING_GUIDE}`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        ...serviceListFiltersSchema
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const filters = {
          ...(args.status !== undefined ? { status: args.status as never } : {}),
          ...(args.includeAllStatuses !== undefined
            ? { includeAllStatuses: args.includeAllStatuses }
            : {}),
          ...(args.fromTimestamp !== undefined
            ? { fromTimestamp: args.fromTimestamp }
            : {}),
          ...(args.updatedSince !== undefined ? { updatedSince: args.updatedSince } : {})
        }
        const listed = await nodeClient.getServices(
          node,
          auth,
          timeoutMs(args.timeout),
          Object.keys(filters).length ? filters : undefined
        )
        const services = listed ?? []
        return commandResultPayload('getServices', {
          scope: 'node-wide',
          ownerScoped: false,
          count: services.length,
          services: services.map((job) => decorateServiceJob(job as never)),
          statusLegend: SERVICE_STATUS_LABELS,
          note:
            'These belong to ALL owners on this node, not just the caller — do not present them ' +
            "as the user's own. Compare the `owner` field against the caller address, or use " +
            'serviceStatus for an owner-scoped view.',
          ...(services.length
            ? {
                syncCursor: String(
                  Math.max(...services.map((s) => Number(s.updatedAt ?? 0) || 0))
                )
              }
            : {})
        })
      } catch (error) {
        return errorPayload(stringifyError(error))
      }
    }
  )

  server.registerTool(
    'serviceExtend',
    {
      title: "Services: extend a running service's paid window",
      description: `Extends a service's paid window (\`${PROTOCOL_COMMANDS.SERVICE_EXTEND}\`). Requires auth. Takes a **new escrow lock + claim** for the additional window.

**Pricing matches the node exactly:** it bills \`additionalDuration\` **alone** (not the new total), priced off the **stored job's** \`resources\` and \`environment\`. So estimate with \`estimateServiceCost(environment = job.environment, resources = job.resources, duration = additionalDuration)\` — take both from \`serviceStatus\`, never re-derive them from env defaults, or you will authorize the wrong amount.

Node-side failure modes worth surfacing to the user:
- only **\`Starting\`/\`Running\`** services are extendable;
- \`remainingSeconds + additionalDuration ≤ serviceOnDemand.maxDurationSeconds\` (node config, default 86400s, not advertised);
- the **access list is re-checked** — a consumer removed from the env's allow-list cannot extend;
- pricing can be **removed mid-service** → \`400\`;
- a crashed prior extension that could not be auto-refunded → **\`409\`**.

${SERVICE_PAYMENT_GUIDE}

${SERVICE_AUTH_NOTE}

${P2P_AUTH_SIGNING_GUIDE}`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        serviceId: serviceIdSchema,
        additionalDuration: z
          .number()
          .int()
          .positive()
          .describe(
            'Extra seconds to add. This alone is what gets billed — not the new total duration.'
          ),
        payment: servicePaymentSchema,
        parallelJobs: z.number().int().positive().optional(),
        skipEscrowPreflight: z
          .boolean()
          .optional()
          .describe('Skip the on-chain escrow gate (use when already provisioned).')
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const ms = timeoutMs(args.timeout)

        // Gate off the STORED job: the node prices an extend from job.resources on
        // job.environment, so anything re-derived here would size the lock wrongly.
        let gate: ReturnType<typeof structuredError> | undefined
        try {
          const existing = await nodeClient.getServiceStatus(
            node,
            auth,
            ms,
            args.serviceId
          )
          const job = (existing ?? []).find((j) => j.serviceId === args.serviceId)
          if (job) {
            const { env } = await findEnvironment(nodeClient, node, ms, job.environment)
            const storedResources = (job.resources ?? []).map(
              (r: { id: string; amount: number }) => ({ id: r.id, amount: r.amount })
            )
            if (env && storedResources.length) {
              gate = await serviceEscrowGate({
                command: 'serviceExtend',
                nodeClient,
                evmRegistry,
                node,
                timeout: ms,
                args,
                env,
                chainId: args.payment.chainId,
                token: args.payment.token,
                resources: storedResources,
                durationSeconds: args.additionalDuration
              })
            }
          }
        } catch {
          // Best-effort, as everywhere else: let the node be authoritative.
        }
        if (gate) return gate

        const result = await nodeClient.serviceExtend(
          node,
          auth,
          args.serviceId,
          args.additionalDuration,
          args.payment,
          ms
        )
        return commandResultPayload('serviceExtend', {
          services: (result ?? []).map(decorateServiceJob),
          addedSeconds: args.additionalDuration,
          minLockSecondsUsedByNode: serviceMinLockSeconds(args.additionalDuration),
          note: 'The node bills additionalDuration alone. Check expiresAtIso to confirm the new window.'
        })
      } catch (error) {
        return errorPayload(stringifyError(error))
      }
    }
  )

  server.registerTool(
    'serviceRestart',
    {
      title: 'Services: restart a service (REUSE stored spec, or RESPEC a new one)',
      description: `Restarts a service (\`${PROTOCOL_COMMANDS.SERVICE_RESTART}\`). Requires auth. **Free** — no new escrow lock — but needs a **claimed** start payment (check \`paymentClaimed\` on \`serviceStatus\`; a service whose start payment was never claimed cannot be restarted, start a new one). An \`Expired (75)\` service cannot be restarted.

Asynchronous like start: returns \`Restarting (45)\` immediately, then poll \`serviceStatus\`.

${SERVICE_RESTART_SEMANTICS_GUIDE}

${SERVICE_POLLING_GUIDE}

${SERVICE_USERDATA_GUIDE}

${P2P_AUTH_SIGNING_GUIDE}`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        serviceId: serviceIdSchema,
        ...serviceContainerSpecSchema
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)

        const containerParams = {
          image: args.image,
          tag: args.tag,
          checksum: args.checksum,
          dockerfile: args.dockerfile,
          additionalDockerFiles: args.additionalDockerFiles,
          dockerCmd: args.dockerCmd,
          dockerEntrypoint: args.dockerEntrypoint,
          userData: args.userData
        }
        const supplied = Object.entries(containerParams)
          .filter(([, v]) => v !== undefined)
          .map(([k]) => k)
        const respec = supplied.length > 0

        // Local RESPEC guard: fail here with the explanation instead of round-tripping to a
        // bare node 400. This is the trap an agent asked to "rotate the API key" walks into.
        if (respec && !args.image) {
          return errorPayload(
            `Restart is atomic — all-old or all-new. You supplied ${supplied.join(', ')}, which ` +
              `switches the node into RESPEC mode, where \`image\` is **mandatory** and anything ` +
              `omitted is empty rather than inherited. The node would reject this with a 400.\n\n` +
              `To change only some fields (e.g. rotate a secret in userData), re-send the FULL ` +
              `spec: read image/tag/dockerCmd/dockerEntrypoint off serviceStatus and pass them ` +
              `again alongside your new value. Note serviceStatus never returns userData (the ` +
              `node strips it), so re-supply every key you want the container to keep.\n\n` +
              `To just bounce the service on its stored spec, call serviceRestart with ONLY ` +
              `serviceId and no container params.`
          )
        }
        if ([args.tag, args.checksum, args.dockerfile].filter(Boolean).length > 1) {
          return errorPayload(
            'Provide at most one of `tag`, `checksum`, `dockerfile` — mutually exclusive image modes.'
          )
        }

        const userDataCheck = parseUserData(args.userData)
        const params: ServiceRestartParams | undefined = respec
          ? (Object.fromEntries(
              Object.entries(containerParams).filter(([, v]) => v !== undefined)
            ) as ServiceRestartParams)
          : undefined

        const result = await nodeClient.serviceRestart(
          node,
          auth,
          args.serviceId,
          timeoutMs(args.timeout),
          params
        )
        return commandResultPayload('serviceRestart', {
          mode: respec ? 'RESPEC' : 'REUSE',
          services: (result ?? []).map(decorateServiceJob),
          userDataKeys: describeUserDataKeys(args.userData),
          ...(userDataCheck.warnings.length
            ? { userDataWarnings: userDataCheck.warnings }
            : {}),
          nextStep:
            'Restart is asynchronous (45 Restarting). Poll serviceStatus until 40 Running. ' +
            'Endpoints are re-published — re-read endpoints[].url rather than reusing the old ones.'
        })
      } catch (error) {
        return errorPayload(stringifyError(error))
      }
    }
  )

  server.registerTool(
    'serviceStop',
    {
      title: 'Services: stop a service (does NOT release the paid reservation)',
      description: `Stops a service's container (\`${PROTOCOL_COMMANDS.SERVICE_STOP}\`). Requires auth, owner-gated.

⚠️ **This does not save money and does not free capacity.** The cpu/ram/gpu and host ports stay **reserved until \`expiresAt\`**; only \`Expired (75)\` releases them. There is **no refund** for the unused window. If the user's goal is to stop paying, tell them that ship has already sailed — the whole window was paid up front at start.

Since the reservation is kept, \`serviceRestart\` resumes on the **same** endpoints later. \`Stopping (50)\` is **not** an end state — keep polling \`serviceStatus\` to \`70 Stopped\`.

Unlike start/extend/restart, stop does **not** re-check the env access list — a consumer removed from an allow-list can still shut their own service down (deliberate: a revoked owner must be able to stop).

${P2P_AUTH_SIGNING_GUIDE}`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        serviceId: serviceIdSchema
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const result = await nodeClient.serviceStop(
          node,
          auth,
          args.serviceId,
          timeoutMs(args.timeout)
        )
        return commandResultPayload('serviceStop', {
          services: (result ?? []).map(decorateServiceJob),
          reservationReleased: false,
          note:
            'The paid resource reservation is KEPT until expiresAt (only status 75 Expired ' +
            'releases it) and there is no refund. Status 50 Stopping is still in flight — poll ' +
            'serviceStatus to 70 Stopped.'
        })
      } catch (error) {
        return errorPayload(stringifyError(error))
      }
    }
  )

  server.registerTool(
    'serviceLogs',
    {
      title: "Services: read a service container's logs",
      description: `Collects a service container's logs (\`${PROTOCOL_COMMANDS.SERVICE_GET_STREAMABLE_LOGS}\`). Requires auth, owner-scoped. Only available while the service is \`Running (40)\` or \`Error (99)\` — otherwise the node returns \`404\`.

Returns **decoded text** when the payload is small and valid UTF-8 (logs are text; base64 would just burn context), else \`dataBase64\`.

⚠️ **\`since\` matters.** With no bound the node streams the container's **entire history** — for a service that has been up for days that is enormous. This tool defaults to \`since: '${DEFAULT_LOG_SINCE}'\` and caps collection at \`maxBytes\` (default ${Math.round(DEFAULT_LOG_MAX_BYTES / 1024)} KiB), reporting \`truncated: true\` rather than returning a huge blob. Ask for full history explicitly (\`since: '0'\`) only when you actually need it.

${P2P_AUTH_SIGNING_GUIDE}`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        serviceId: serviceIdSchema,
        since: z
          .string()
          .optional()
          .describe(
            `Lower time bound: Unix **seconds**, or a relative duration like '30s'/'2h'/'7d'. Defaults to '${DEFAULT_LOG_SINCE}'. Pass '0' for the container's full history (can be very large).`
          ),
        maxBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Cap on collected bytes (default ${DEFAULT_LOG_MAX_BYTES}). Collection stops there and reports truncated: true.`
          )
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const since = args.since ?? DEFAULT_LOG_SINCE
        const result = await nodeClient.serviceLogs(
          node,
          auth,
          args.serviceId,
          timeoutMs(args.timeout),
          since === '0' ? undefined : since,
          args.maxBytes ?? DEFAULT_LOG_MAX_BYTES
        )
        return commandResultPayload('serviceLogs', {
          ...result,
          since: since === '0' ? 'full history' : since,
          ...(result.truncated
            ? {
                truncationNote:
                  'Output was cut at maxBytes. Narrow `since` or raise `maxBytes` — do not assume ' +
                  'the tail of the log is here.'
              }
            : {})
        })
      } catch (error) {
        return errorPayload(stringifyError(error))
      }
    }
  )
}
