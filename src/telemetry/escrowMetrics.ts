/**
 * Escrow-preflight metrics, recorded at the **function** layer rather than the tool layer.
 *
 * `runEscrowPreflight` has three call sites and only one of them is a tool:
 *
 *   | call site                                            | caller          |
 *   |------------------------------------------------------|-----------------|
 *   | `registerEscrowPreflightTool` cb (`escrowPreflight`)  | `tool`          |
 *   | `escrowPreflightGate` (`p2pProviderTools.ts:56`)      | `compute_gate`  |
 *   | `serviceEscrowGate` (`serviceTools.ts:178`)           | `service_gate`  |
 *
 * Hooking the tool name would leave both gates at zero and make the paid-compute and service
 * funnels look like a total drop-off at the payment step, when in fact most preflights are the
 * implicit gates inside `computeStart`/`serviceStart`.
 */
import { escrowAutofix, escrowPreflight } from './metrics.js'

/**
 * `tool_recheck` is the second preflight the tool runs after an auto-fix, to confirm the fix
 * landed. It is a separate value rather than a second `tool` increment so the tool's call count
 * is not silently doubled for every auto-fixed user — and the before/after pair is itself the
 * "did auto-fix actually work" signal.
 */
export type PreflightCaller = 'tool' | 'tool_recheck' | 'compute_gate' | 'service_gate'

type PreflightVerdict = {
  canStartThisJob: boolean
  reason?: string
}

/**
 * Record one escrow verdict.
 *
 * Keyed off `canStartThisJob` — the condition the node actually enforces at `createLock` — not the
 * generous `ready` target, which is provisioning advice and would over-report blockage.
 *
 * Never throws: this sits inside the escrow gate, and a telemetry failure must not turn a
 * proceed-decision into a block.
 */
export function recordPreflight(result: PreflightVerdict, caller: PreflightCaller): void {
  try {
    escrowPreflight.add(1, {
      result: result.canStartThisJob ? 'ready' : `blocked_${result.reason ?? 'unknown'}`,
      caller
    })
  } catch {
    // no-op
  }
}

/**
 * A preflight that could not reach a verdict — an RPC read failed, the escrow contract was
 * unreachable, an address was malformed.
 *
 * Without this the counter is silently biased: both gates swallow their errors and proceed
 * ("best-effort, let the node decide"), so an escrow backend that is down looks like *no preflight
 * traffic at all* rather than a problem. `result="error"` keeps the denominator honest, which is
 * what makes `ocean_mcp:escrow_gate_block_rate` trustworthy.
 */
export function recordPreflightError(caller: PreflightCaller): void {
  try {
    escrowPreflight.add(1, { result: 'error', caller })
  } catch {
    // no-op
  }
}

/**
 * Auto-fix outcomes, as their own counter rather than an `auto_fixed` boolean on the verdict.
 *
 * Two reasons. The verdict is recorded inside `runEscrowPreflight`, which returns *before* auto-fix
 * runs, so a boolean there could only ever be `false`. And the boolean was lossy anyway: a "note"
 * action (`escrowPreflight.ts:360-361`) reports that an existing authorization is below target and
 * **cannot** be raised automatically — it is a no-op dressed as an action. `outcome` separates the
 * transactions that actually ran from that advisory case.
 */
export function recordAutoFix(
  actions: Array<{ action: string; tx?: string; note?: string }> | undefined
): void {
  if (!actions?.length) return
  try {
    for (const entry of actions) {
      const outcome = entry.tx ? entry.action : 'noop'
      escrowAutofix.add(1, { outcome })
    }
  } catch {
    // no-op
  }
}
