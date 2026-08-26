/**
 * Every OTel instrument the server emits, defined once at module load and reused across sessions.
 *
 * This module depends on `@opentelemetry/api` **only** — never on the SDK. Without a registered
 * provider the API returns no-op instruments, so `record()`/`add()` calls from the tool wrapper
 * cost approximately nothing on the stdio path and in tests. That is what lets the instrumentation
 * be unconditional at the call sites and conditional only here.
 *
 * Metric and attribute names are the contract documented in `docs/telemetry/README.md`; changing
 * one breaks the shipped Grafana dashboard.
 */
import { metrics, type Attributes } from '@opentelemetry/api'

const meter = metrics.getMeter('ocean-mcp', '0.0.1')

/* ── Core usage ───────────────────────────────────────────────────────────────── */

export const toolCalls = meter.createCounter('mcp.tool.calls', {
  description: 'Tool invocations, by tool, category, and outcome',
  unit: '{call}'
})

export const toolDuration = meter.createHistogram('mcp.tool.duration', {
  description: 'Tool call latency',
  unit: 'ms'
})

export const sessionsActive = meter.createUpDownCounter('mcp.sessions.active', {
  description: 'Currently open MCP sessions',
  unit: '{session}'
})

export const sessionsStarted = meter.createCounter('mcp.sessions.started', {
  description:
    'Sessions initialized. Session ids are fresh UUIDs, so increase() is a distinct count',
  unit: '{session}'
})

export const sessionsEmpty = meter.createCounter('mcp.sessions.empty', {
  description: 'Sessions that initialized then made zero tool calls (bounce)',
  unit: '{session}'
})

export const sessionDuration = meter.createHistogram('mcp.session.duration', {
  description: 'Session lifetime',
  unit: 's'
})

export const sessionToolCalls = meter.createHistogram('mcp.session.tool_calls', {
  description: 'Tool calls per session',
  unit: '{call}'
})

export const sessionDistinctTools = meter.createHistogram('mcp.session.distinct_tools', {
  description: 'Distinct tools touched per session (exploration breadth)',
  unit: '{tool}'
})

export const sessionTimeToFirstCall = meter.createHistogram(
  'mcp.session.time_to_first_call',
  {
    description:
      'Seconds from session initialize to its first tool call. Sessions that never call a tool are counted by mcp.sessions.empty instead',
    unit: 's'
  }
)

export const transportRejected = meter.createCounter('mcp.transport.rejected', {
  description:
    'HTTP requests rejected before reaching a tool (dead session id, malformed request). Invisible to mcp.tool.calls by definition',
  unit: '{request}'
})

export const resourceReads = meter.createCounter('mcp.resource.reads', {
  description: 'Resource reads',
  unit: '{read}'
})

export const promptGets = meter.createCounter('mcp.prompt.gets', {
  description: 'Prompt template fetches',
  unit: '{get}'
})

/* ── Ocean domain ─────────────────────────────────────────────────────────────── */

export const computeJobsStarted = meter.createCounter('mcp.compute.jobs.started', {
  description: 'Compute jobs started, paid and free',
  unit: '{job}'
})

export const computeJobsObserved = meter.createCounter('mcp.compute.jobs.observed', {
  description: 'Terminal compute-job outcomes observed, deduped per jobId',
  unit: '{job}'
})

export const computeJobDuration = meter.createHistogram(
  'mcp.compute.job.observed_duration',
  {
    description:
      'Seconds from the FIRST observed poll of a job to its terminal poll. A lower bound on true job lifetime — the job was already running when first seen, and the terminal state is only noticed at the next poll',
    unit: 's'
  }
)

export const computeJobPolls = meter.createHistogram('mcp.compute.job.polls', {
  description:
    'computeStatus calls observed for a job before it reached a terminal state',
  unit: '{poll}'
})

export const assetOrder = meter.createCounter('mcp.asset.order', {
  description:
    'order_asset invocations by funnel status. The tool is a multi-step state machine, so this counts step transitions, not distinct orders',
  unit: '{step}'
})

export const assetDownloads = meter.createCounter('mcp.asset.downloads', {
  description: 'Asset file downloads attempted',
  unit: '{download}'
})

export const assetFeeQuotes = meter.createCounter('mcp.asset.fee_quotes', {
  description: 'Download-fee quotes requested (get_download_fees) — purchase intent',
  unit: '{quote}'
})

export const ddoResolve = meter.createCounter('mcp.ddo.resolve', {
  description:
    'DDO resolution / validation attempts by hit-miss. A precondition for ordering, compute and download alike',
  unit: '{lookup}'
})

export const storageOperations = meter.createCounter('mcp.storage.operations', {
  description: 'Persistent-storage operations, by action',
  unit: '{op}'
})

export const escrowTxBuilt = meter.createCounter('mcp.escrow.tx_built', {
  description:
    'Unsigned escrow transactions built (deposit/withdraw/authorize). These tools never sign or broadcast, so this measures INTENT to move funds, not settlement',
  unit: '{tx}'
})

export const escrowPreflight = meter.createCounter('mcp.escrow.preflight', {
  description: 'Escrow readiness verdicts, by outcome and calling context',
  unit: '{check}'
})

export const escrowAutofix = meter.createCounter('mcp.escrow.autofix', {
  description: 'Escrow auto-fix actions attempted by the escrow_preflight tool',
  unit: '{action}'
})

export const authTokensCreated = meter.createCounter('mcp.auth.tokens_created', {
  description: 'Auth tokens minted (paid-compute intent)',
  unit: '{token}'
})

export const providerLookup = meter.createCounter('mcp.p2p.provider_lookup', {
  description: 'DID to provider discovery attempts, by hit/miss',
  unit: '{lookup}'
})

export const incentivesCalls = meter.createCounter('mcp.incentives.calls', {
  description: 'Incentives / node-operator tool usage',
  unit: '{call}'
})

export const chainUsage = meter.createCounter('mcp.chain.usage', {
  description: 'Tool calls carrying a chainId, by chain',
  unit: '{call}'
})

export const docsSearch = meter.createCounter('mcp.docs.search', {
  description: 'Docs searches, by hit/miss (content-gap signal)',
  unit: '{search}'
})

/* ── Service-on-Demand ──────────────────────────────────────────────────────── */

export const serviceStarted = meter.createCounter('mcp.service.started', {
  description:
    'Service start attempts. Start is async, so this counts attempts, not successes',
  unit: '{service}'
})

export const serviceObserved = meter.createCounter('mcp.service.observed', {
  description: 'Terminal service outcomes observed, deduped per serviceId',
  unit: '{service}'
})

export const serviceCostEstimates = meter.createCounter('mcp.service.cost_estimates', {
  description: 'Service cost estimates requested',
  unit: '{estimate}'
})

export const serviceLifecycle = meter.createCounter('mcp.service.lifecycle', {
  description: 'Post-start service actions (extend/restart/stop/logs/list)',
  unit: '{call}'
})

export const serviceTimeToRunning = meter.createHistogram('mcp.service.time_to_running', {
  description:
    'Seconds from the first observed poll of a service to the poll where it reached Running (40). Covers the escrow lock, image pull/build and scan — the slow part of a start',
  unit: 's'
})

export const serviceDuration = meter.createHistogram('mcp.service.observed_duration', {
  description:
    'Seconds from the first observed poll of a service to its terminal poll. A lower bound, bounded by how often the client polls',
  unit: 's'
})

export const servicePolls = meter.createHistogram('mcp.service.polls', {
  description: 'serviceStatus calls observed for a service before it settled',
  unit: '{poll}'
})

/* ── Health ───────────────────────────────────────────────────────────────────── */

export const connectedPeers = meter.createObservableGauge('mcp.p2p.connected_peers', {
  description: 'Live libp2p connections (connected, not merely discovered)',
  unit: '{peer}'
})

export const usersActiveEstimate = meter.createObservableGauge(
  'mcp.users.active.estimate',
  {
    description:
      'HyperLogLog estimate of distinct users (hash of IP + client) per calendar window. Lower bound of the user range',
    unit: '{user}'
  }
)

/** Narrow alias so call sites cannot accidentally pass an unbounded value as an attribute. */
export type MetricAttributes = Attributes
