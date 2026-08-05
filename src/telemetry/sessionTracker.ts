/**
 * Per-session state and the session lifecycle metrics.
 *
 * One entry per MCP session, created on `initialize` and retired on `transport.onclose`. Holds the
 * anonymous `user.id` the tool wrapper stamps on spans, plus the counters that can only be emitted
 * once the session is over (duration, calls, breadth, bounce).
 */
import {
  sessionDistinctTools,
  sessionDuration,
  sessionTimeToFirstCall,
  sessionToolCalls,
  sessionsActive,
  sessionsEmpty,
  sessionsStarted
} from './metrics.js'
import { recordUser } from './userHll.js'

export type SessionMeta = {
  sessionId: string
  /** Hashed id; `undefined` when the client IP was unknown. Spans only, never a label. */
  userId?: string
  clientName: string
  clientVersion: string
  startedAt: number
  toolCalls: number
  distinctTools: Set<string>
  recordToolUse: (name: string) => void
}

/** Emitted on the first tool call of a session — see `mcp.session.time_to_first_call`. */
function recordActivation(meta: SessionMeta): void {
  sessionTimeToFirstCall.record((Date.now() - meta.startedAt) / 1000, {
    'client.name': meta.clientName
  })
}

const sessions = new Map<string, SessionMeta>()

/**
 * Hard cap on tracked sessions. `transport.onclose` is reliable in practice, but a leaked session
 * must degrade into a bounded miscount rather than an unbounded map on a long-lived server.
 */
const MAX_TRACKED_SESSIONS = 10_000

export function startSession(
  sessionId: string,
  info: { userId?: string; clientName: string; clientVersion: string }
): SessionMeta {
  const existing = sessions.get(sessionId)
  if (existing) return existing

  if (sessions.size >= MAX_TRACKED_SESSIONS) {
    // Drop the oldest insertion; Map preserves insertion order.
    const oldest = sessions.keys().next().value
    if (oldest !== undefined) sessions.delete(oldest)
  }

  const meta: SessionMeta = {
    sessionId,
    userId: info.userId,
    clientName: info.clientName,
    clientVersion: info.clientVersion,
    startedAt: Date.now(),
    toolCalls: 0,
    distinctTools: new Set<string>(),
    recordToolUse(name: string) {
      // Activation latency: how long the client spent listing tools, reading resources and
      // deciding before it did anything. `sessions.empty` counts the ones that never got here;
      // this measures how long the rest took, which separates "slow" from "never".
      if (this.toolCalls === 0) recordActivation(this)
      this.toolCalls++
      this.distinctTools.add(name)
    }
  }
  sessions.set(sessionId, meta)

  const labels = { 'client.name': info.clientName }
  sessionsActive.add(1, labels)
  sessionsStarted.add(1, {
    ...labels,
    'client.version': info.clientVersion
  })
  recordUser(info.userId)

  return meta
}

export function getSession(sessionId: string | undefined): SessionMeta | undefined {
  return sessionId ? sessions.get(sessionId) : undefined
}

/**
 * Retire a session and emit its end-of-life metrics. Idempotent: the SDK can fire `onclose` more
 * than once, and double-counting a session's duration would skew every percentile.
 */
export function endSession(sessionId: string | undefined): void {
  if (!sessionId) return
  const meta = sessions.get(sessionId)
  if (!meta) return
  sessions.delete(sessionId)

  const labels = { 'client.name': meta.clientName }
  sessionsActive.add(-1, labels)
  sessionDuration.record((Date.now() - meta.startedAt) / 1000, labels)
  sessionToolCalls.record(meta.toolCalls, labels)
  sessionDistinctTools.record(meta.distinctTools.size, labels)
  if (meta.toolCalls === 0) sessionsEmpty.add(1, labels)
}

export function activeSessionCount(): number {
  return sessions.size
}

/** Test-only. */
export function resetSessionsForTest(): void {
  sessions.clear()
}
