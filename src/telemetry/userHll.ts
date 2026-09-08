/**
 * Unique-user estimation via HyperLogLog, exported as `mcp.users.active.estimate{window}`.
 *
 * Why a sketch rather than a label: OTel metrics cannot `COUNT(DISTINCT)`, and putting a per-user
 * hash on a metric label would hand Mimir an unbounded series set. An in-process HLL collapses the
 * whole question into **three** series (day/week/month) at ~2% error.
 *
 * Two properties are deliberate, documented, and must not be "fixed" silently:
 *  1. **Calendar buckets, not sliding windows.** Each window resets at its UTC boundary. A restart
 *     mid-window undercounts until it re-accumulates; the dashboard panels say so.
 *  2. **Single instance only.** Per-replica estimates cannot be summed — that needs a sketch union.
 *     Flag this before any horizontal scale-out.
 *
 * The metric needs no configuration: `user.id` is an unsalted hash (see `identity.ts`), so identity
 * is stable across restarts and replicas for free, with no secret to provision and no path where a
 * missing one silently disables the count.
 *
 * The HLL is ~60 lines and vendored rather than pulled in as a dependency: the alternative is a
 * transitive dep in the server image for one gauge.
 */
import { usersActiveEstimate } from './metrics.js'

/** 2^14 registers → ~0.8% standard error, 16 KB per window. */
const P = 14
const REGISTERS = 1 << P
const ALPHA = 0.7213 / (1 + 1.079 / REGISTERS)

/**
 * FNV-1a followed by MurmurHash3's `fmix32` finaliser.
 *
 * The finaliser is not optional. HLL takes the register index from the **high** bits, and raw
 * FNV-1a avalanches those poorly for short, similar inputs — which is precisely the shape of a
 * user-id set. Without mixing, distinct ids collide into the same registers and the estimate
 * reads ~12% low.
 */
function hash32(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

class HyperLogLog {
  private registers = new Uint8Array(REGISTERS)

  add(value: string): void {
    const h = hash32(value)
    const index = h >>> (32 - P)
    // Rank = position of the leftmost 1 in the remaining bits, 1-based.
    const remaining = (h << P) >>> 0
    const rank = remaining === 0 ? 32 - P + 1 : Math.clz32(remaining) + 1
    if (rank > this.registers[index]) this.registers[index] = rank
  }

  count(): number {
    let sum = 0
    let zeros = 0
    for (let i = 0; i < REGISTERS; i++) {
      const r = this.registers[i]
      sum += 2 ** -r
      if (r === 0) zeros++
    }
    const estimate = (ALPHA * REGISTERS * REGISTERS) / sum
    // Linear counting is far more accurate than HLL in the small-cardinality range, which is
    // exactly where this server will live for a while.
    if (estimate <= 2.5 * REGISTERS && zeros > 0) {
      return Math.round(REGISTERS * Math.log(REGISTERS / zeros))
    }
    return Math.round(estimate)
  }

  reset(): void {
    this.registers = new Uint8Array(REGISTERS)
  }
}

export type UserWindow = 'day' | 'week' | 'month'

/** UTC calendar-bucket key. A change in the key is the reset signal. */
export function bucketKey(window: UserWindow, now: Date): string {
  const year = now.getUTCFullYear()
  if (window === 'month') {
    return `${year}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  }
  if (window === 'day') {
    return `${year}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(
      now.getUTCDate()
    ).padStart(2, '0')}`
  }
  // Week: days since the epoch, floored into 7-day blocks. Not ISO weeks — this only has to be a
  // stable, monotonically advancing bucket, and epoch-relative blocks are unambiguous.
  const epochDays = Math.floor(now.getTime() / 86_400_000)
  return `w${Math.floor(epochDays / 7)}`
}

const WINDOWS: UserWindow[] = ['day', 'week', 'month']

const sketches = new Map<UserWindow, { hll: HyperLogLog; key: string }>()

function sketchFor(window: UserWindow, now: Date): HyperLogLog {
  const key = bucketKey(window, now)
  const existing = sketches.get(window)
  if (existing && existing.key === key) return existing.hll
  const fresh = { hll: new HyperLogLog(), key }
  sketches.set(window, fresh)
  return fresh.hll
}

/**
 * Fold one anonymous user id into every window. No-op on `undefined`, which `deriveUserId` returns
 * when the client IP could not be determined.
 */
export function recordUser(userId: string | undefined, now: Date = new Date()): void {
  if (!userId) return
  for (const window of WINDOWS) sketchFor(window, now).add(userId)
}

export function estimate(window: UserWindow, now: Date = new Date()): number {
  return sketchFor(window, now).count()
}

let registered = false

/** Attach the observable gauge callback. Idempotent; safe to call when telemetry is disabled. */
export function registerUserGauge(): void {
  if (registered) return
  registered = true
  usersActiveEstimate.addCallback((result) => {
    const now = new Date()
    for (const window of WINDOWS) {
      result.observe(estimate(window, now), { window })
    }
  })
}

/** Test-only: clear all sketches. */
export function resetUserSketchesForTest(): void {
  sketches.clear()
}
