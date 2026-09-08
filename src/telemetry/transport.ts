/**
 * Transport-level rejections — requests that never reach a tool.
 *
 * These are a blind spot in every other metric by construction: `mcp.tool.calls` only sees calls
 * that reached a handler, and `mcp.sessions.*` only sees sessions that were successfully created.
 * A client hammering a dead session id after a deploy produces a wall of 404s and moves none of
 * those series at all.
 */
import { transportRejected } from './metrics.js'

export type RejectionReason =
  /** A `mcp-session-id` we have no transport for — usually a session that died with a restart. */
  | 'session_not_found'
  /** Not an initialize request and no usable session id. */
  | 'invalid_request'
  /** The request threw before or during transport handling. */
  | 'handler_error'

/** Never throws: this sits on the request path, including its error branch. */
export function recordTransportRejection(reason: RejectionReason): void {
  try {
    transportRejected.add(1, { reason })
  } catch {
    // no-op
  }
}
