/**
 * Ocean-domain metrics derived from tool results.
 *
 * One map in one file rather than ~92 call-site edits. Every branch is defensive: a shape change
 * upstream must degrade to "no metric", never to a thrown error inside the tool wrapper.
 *
 * **Results are JSON *strings*, not live objects.** Tools return
 * `{content:[{type:'text', text: toPrettyJson({command, result})}]}` (`evmToolUtils.ts:46`), so
 * everything here goes through `payload()` first. Two families break that envelope and are handled
 * explicitly: `search_docs` returns prose, and `serviceTools.ts:78` returns a plain-text error.
 */
import {
  SERVICE_END_STATUSES,
  TERMINAL_FAILURE_STATUSES
} from '../tools/serviceSchemas.js'
import {
  assetDownloads,
  assetFeeQuotes,
  assetOrder,
  authTokensCreated,
  computeJobDuration,
  computeJobPolls,
  computeJobsObserved,
  computeJobsStarted,
  ddoResolve,
  docsSearch,
  escrowTxBuilt,
  incentivesCalls,
  providerLookup,
  serviceCostEstimates,
  serviceDuration,
  serviceLifecycle,
  serviceObserved,
  servicePolls,
  serviceStarted,
  serviceTimeToRunning,
  storageOperations
} from './metrics.js'

type ToolResult = { content?: Array<{ type?: string; text?: string }>; isError?: boolean }

/** Raw text of the first content block, or `undefined`. */
function text(res: unknown): string | undefined {
  const content = (res as ToolResult | undefined)?.content
  if (!Array.isArray(content)) return undefined
  const first = content[0]
  return typeof first?.text === 'string' ? first.text : undefined
}

/**
 * Unwrap `toPrettyJson({command, result})` → `result`.
 *
 * The try/catch is load-bearing, not defensive padding: `serviceTools.ts:78` returns a plain-text
 * error with no JSON envelope at all. Every caller must tolerate `undefined`.
 */
export function payload(res: unknown): any {
  const raw = text(res)
  if (!raw) return undefined
  try {
    return JSON.parse(raw)?.result
  } catch {
    return undefined
  }
}

type PollState = {
  firstSeenAt: number
  polls: number
  /** Milestones already emitted for this id, so each fires at most once. */
  emitted: Set<string>
}

/**
 * Per-id polling state, bounded in size.
 *
 * This is the dedup mechanism *and* the duration source. Clients poll `computeStatus` and
 * `serviceStatus` every 5–10s, so we already had to remember which ids were counted; remembering
 * *when* each was first seen and how many polls it took costs two extra fields and yields
 * observed-duration and poll-depth for free.
 *
 * `jobId` / `serviceId` are **in-memory keys only** and must never reach a metric label. The size
 * cap stops a long-lived server from growing this unboundedly.
 */
class PollTracker {
  private readonly items = new Map<string, PollState>()
  private readonly max = 5_000

  /** Register a sighting of `key` and return its running state. */
  poll(key: string, now: number): PollState {
    const existing = this.items.get(key)
    if (existing) {
      existing.polls++
      return existing
    }
    if (this.items.size >= this.max) {
      const oldest = this.items.keys().next().value
      if (oldest !== undefined) this.items.delete(oldest)
    }
    const fresh: PollState = { firstSeenAt: now, polls: 1, emitted: new Set<string>() }
    this.items.set(key, fresh)
    return fresh
  }

  /** `true` the first time `milestone` is claimed for `key`. */
  claim(state: PollState, milestone: string): boolean {
    if (state.emitted.has(milestone)) return false
    state.emitted.add(milestone)
    return true
  }

  clear(): void {
    this.items.clear()
  }
}

const computeJobs = new PollTracker()
const serviceJobs = new PollTracker()

/** Seconds since `firstSeenAt`, the honest lower bound on elapsed time. */
function observedSeconds(state: PollState, now: number): number {
  return (now - state.firstSeenAt) / 1000
}

/* ── Compute status ─────────────────────────────────────────────────────────────────────── */

const COMPUTE_FAILURE_KEYWORDS = [
  'failed',
  'expired',
  'vulnerabilities',
  'disk quota exceeded'
]

/**
 * C2D terminal classification. **70 AND 71 are both success**, and failures are detected by
 * `statusText` keyword rather than a numeric range (`p2pSchemas.ts:129-130`) — the failure codes
 * are scattered (11, 13, 32, 41, 61, 62), so a range test would be wrong.
 */
export function classifyComputeJob(job: {
  status?: unknown
  statusText?: unknown
}): 'success' | 'failed' | undefined {
  const status = typeof job?.status === 'number' ? job.status : undefined
  if (status === 70 || status === 71) return 'success'
  const statusText =
    typeof job?.statusText === 'string' ? job.statusText.toLowerCase() : ''
  if (COMPUTE_FAILURE_KEYWORDS.some((keyword) => statusText.includes(keyword))) {
    return 'failed'
  }
  return undefined // still running — do not count
}

/* ── Service status ─────────────────────────────────────────────────────────────────────── */

/**
 * Service terminal classification. Deliberately **not** shared with `classifyComputeJob`: the two
 * vocabularies collide on the number 70, which is *success* for a compute job and *stopped* for a
 * service. `40 Running` is reported separately as the "did it ever come up" milestone
 * — it is a success signal, not an end state.
 */
export function classifyServiceJob(job: {
  status?: unknown
}): 'running' | 'failed' | 'stopped' | 'expired' | undefined {
  const status = typeof job?.status === 'number' ? job.status : undefined
  if (status === undefined) return undefined
  if (status === 40) return 'running'
  if (TERMINAL_FAILURE_STATUSES.includes(status)) return 'failed'
  if (status === 70) return 'stopped'
  if (status === 75) return 'expired'
  // Everything else (10 Starting, 45 Restarting, 50 Stopping, …) is in flight.
  return SERVICE_END_STATUSES.includes(status) ? 'stopped' : undefined
}

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value
  return value && typeof value === 'object' ? [value] : []
}

/** Jobs can arrive as an array, a bare object, or nested under a `services`/`jobs` key. */
function jobsFrom(result: any, key: 'services' | 'jobs'): any[] {
  if (!result) return []
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.[key])) return result[key]
  return asArray(result)
}

/* ── The map ────────────────────────────────────────────────────────────────────────────── */

const SERVICE_LIFECYCLE_ACTIONS: Record<string, string> = {
  serviceExtend: 'extend',
  serviceRestart: 'restart',
  serviceStop: 'stop',
  serviceLogs: 'logs',
  getServices: 'list'
}

/**
 * The `status` values `order_asset` actually returns (`assets.ts`). Enforced rather than trusted:
 * this label is derived from a result payload, and the file's invariant is that every metric label
 * is bounded at the point of use, not by inspection of the producer.
 */
const ASSET_ORDER_STATUSES = new Set(['needs_broadcast', 'waiting', 'complete'])

/** Bucket names, never bucket contents: no bucket id, file name or object key is recorded. */
const STORAGE_ACTIONS: Record<string, string> = {
  createPersistentStorageBucket: 'create_bucket',
  getPersistentStorageBuckets: 'list_buckets',
  listPersistentStorageFiles: 'list_files',
  getPersistentStorageFileObject: 'get_object',
  deletePersistentStorageFile: 'delete_file',
  upload_persistent_storage_file: 'upload'
}

/**
 * Record domain metrics for one completed tool call.
 *
 * Never throws: the wrapper calls this on the success path of a real tool invocation, and a
 * telemetry bug must not turn a working tool call into an error.
 */
export function inspectResult(name: string, args: any, res: unknown): void {
  try {
    inspect(name, args, res)
  } catch {
    // Deliberately silent: a malformed payload is not worth a log line per call.
  }
}

function inspect(name: string, args: any, res: unknown): void {
  const isError = (res as ToolResult | undefined)?.isError === true

  switch (name) {
    case 'computeStart': {
      if (isError) return
      computeJobsStarted.add(1, {
        paid: true,
        ...(typeof args?.chainId === 'number' ? { 'chain.id': args.chainId } : {})
      })
      return
    }

    case 'freeComputeStart': {
      if (isError) return
      computeJobsStarted.add(1, { paid: false })
      return
    }

    case 'computeStatus': {
      const now = Date.now()
      for (const job of jobsFrom(payload(res), 'jobs')) {
        const jobId = job?.jobId ?? job?.id
        // No id → cannot dedup, and clients poll every 5-10s. Skipping is the safe direction:
        // an undercount beats a 20-100x overcount.
        if (typeof jobId !== 'string') continue

        // Tracked on every poll, terminal or not — that is what makes the poll count and the
        // first-seen timestamp meaningful.
        const state = computeJobs.poll(jobId, now)

        const outcome = classifyComputeJob(job)
        if (!outcome) continue
        if (computeJobs.claim(state, 'terminal')) {
          computeJobsObserved.add(1, { 'job.status': outcome })
          computeJobDuration.record(observedSeconds(state, now), {
            'job.status': outcome
          })
          computeJobPolls.record(state.polls, { 'job.status': outcome })
        }
      }
      return
    }

    case 'create_auth_token': {
      if (!isError) authTokensCreated.add(1)
      return
    }

    case 'find_provider':
    case 'find_compute_providers':
    case 'is_valid_provider': {
      const result = payload(res)
      const found = Array.isArray(result)
        ? result.length > 0
        : Array.isArray(result?.providers)
          ? result.providers.length > 0
          : Boolean(result)
      providerLookup.add(1, { found: !isError && found })
      return
    }

    case 'order_asset': {
      // A multi-step state machine, not a one-shot call: the tool returns a step, the caller signs
      // and broadcasts it, then calls back with `state` + `lastTxHash`. `status` is already a
      // bounded enum from the handler, so it gives us drop-off *inside* one tool — how many order
      // flows reach `complete` versus stall after a signature.
      const result = payload(res)
      const raw = result?.status
      const status =
        typeof raw !== 'string'
          ? 'unknown' // no parseable payload at all
          : ASSET_ORDER_STATUSES.has(raw)
            ? raw
            : 'other' // a status the handler does not document — bounded, not forwarded
      assetOrder.add(1, {
        status: isError ? 'error' : status,
        ...(typeof args?.chainId === 'number' ? { 'chain.id': args.chainId } : {})
      })
      return
    }

    case 'download_asset_file': {
      assetDownloads.add(1, { status: isError ? 'error' : 'ok' })
      return
    }

    case 'get_download_fees': {
      assetFeeQuotes.add(1, { status: isError ? 'error' : 'ok' })
      return
    }

    case 'resolveDdo':
    case 'validateDdo':
    case 'check_did_files': {
      // DDO resolution is the precondition for ordering, compute and download alike, so its hit
      // rate is a leading indicator for all three. The DID itself is never recorded.
      const operation =
        name === 'resolveDdo'
          ? 'resolve'
          : name === 'validateDdo'
            ? 'validate'
            : 'check_files'
      ddoResolve.add(1, { operation, found: !isError && payload(res) !== undefined })
      return
    }

    case 'escrow_deposit':
    case 'escrow_withdraw':
    case 'escrow_authorize': {
      // These build an UNSIGNED transaction and never broadcast, so this is intent to move funds,
      // not settlement. Settlement happens later via broadcast_transaction, which is generic and
      // cannot be attributed back to escrow. Amounts are never recorded.
      escrowTxBuilt.add(1, {
        action: name.slice('escrow_'.length),
        status: isError ? 'error' : 'ok'
      })
      return
    }

    case 'search_docs': {
      // Prose, not an envelope: `registerDocsTools.ts` returns either "No results found for: …"
      // or "Found N result(s) for …". The query itself is never recorded.
      const body = text(res) ?? ''
      docsSearch.add(1, { 'result.hit': !body.startsWith('No results found') })
      return
    }

    case 'serviceStart': {
      if (isError) return
      serviceStarted.add(1, {
        'image.mode': args?.dockerfile
          ? 'dockerfile'
          : args?.checksum
            ? 'checksum'
            : 'tag',
        ...(typeof args?.chainId === 'number' ? { 'chain.id': args.chainId } : {})
      })
      return
    }

    case 'serviceStatus': {
      const now = Date.now()
      for (const job of jobsFrom(payload(res), 'services')) {
        const serviceId = job?.serviceId
        if (typeof serviceId !== 'string') continue

        const state = serviceJobs.poll(serviceId, now)

        const outcome = classifyServiceJob(job)
        if (!outcome) continue

        // "Reached Running" and "ended" are separate once-per-service milestones, so a service
        // that starts and later stops contributes one of each. That is what makes
        // observed{running} / started a meaningful start-success rate.
        const milestone = outcome === 'running' ? 'running' : 'terminal'
        if (!serviceJobs.claim(state, milestone)) continue

        serviceObserved.add(1, { 'service.status': outcome })
        servicePolls.record(state.polls, { 'service.status': outcome })

        if (outcome === 'running') {
          // Time to come up: escrow lock + image pull/build + vulnerability scan + container
          // start. This is the slow, expensive part of a service start.
          serviceTimeToRunning.record(observedSeconds(state, now))
        } else {
          serviceDuration.record(observedSeconds(state, now), {
            'service.status': outcome
          })
        }
      }
      return
    }

    case 'estimateServiceCost': {
      const result = payload(res)
      serviceCostEstimates.add(1, {
        estimated: !isError && result !== undefined,
        ...(typeof args?.chainId === 'number' ? { 'chain.id': args.chainId } : {})
      })
      return
    }

    default: {
      const action = SERVICE_LIFECYCLE_ACTIONS[name]
      if (action) {
        serviceLifecycle.add(1, { action })
        return
      }
      const storageAction = STORAGE_ACTIONS[name]
      if (storageAction) {
        storageOperations.add(1, {
          action: storageAction,
          status: isError ? 'error' : 'ok'
        })
        return
      }
      if (name === 'check_node_eligibility' || name.startsWith('incentives_')) {
        incentivesCalls.add(1, { 'tool.name': name })
      }
    }
  }
}

/**
 * `order_asset` throws on the no-providers path (`assets.ts:194`) rather than returning a result,
 * so the miss can only be counted from the wrapper's catch block.
 */
export function recordProviderLookupFailure(name: string): void {
  if (name === 'order_asset') providerLookup.add(1, { found: false })
}

/** Test-only. */
export function resetDedupForTest(): void {
  computeJobs.clear()
  serviceJobs.clear()
}
