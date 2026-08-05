/**
 * Anonymous user identity and client-label sanitization.
 *
 * `user.id` is a SHA-256 of `client IP + client name`, truncated to 16 hex chars. The raw IP is
 * used to compute it and immediately discarded — never stored, logged or exported. The id appears
 * on **spans only**, never as a metric label, where a per-user value would explode Mimir's
 * cardinality (plan §2, §8).
 *
 * The hash is unsalted by deliberate choice. That keeps user identity stable with **zero
 * configuration** — nothing to provision, nothing to keep in sync across restarts or replicas, and
 * no failure mode where a missing secret silently disables the metric. The trade-off, recorded here
 * so it is not rediscovered as a surprise: an unsalted hash over a small input space (IPv4 plus a
 * ~20-value client allowlist) is reversible by brute force, so treat `user.id` as pseudonymous
 * rather than anonymous, and scope access to the telemetry backend accordingly.
 *
 * The source port is deliberately excluded: TCP source ports are per-connection and re-mapped by
 * NAT PAT, so folding one in turns the id into a *connection* id and fragments a single user
 * across their own requests. `MCP_TELEMETRY_USER_ID_INCLUDE_PORT=1` exists only to experiment.
 */
import { createHash } from 'node:crypto'
import type { Request } from 'express'

import { telemetryConfig } from './config.js'

/**
 * Clients we are willing to emit verbatim as a metric label. `clientInfo` is free text chosen by
 * the client, so an allowlist is the only thing standing between a buggy or hostile client and an
 * unbounded label set (plan §2 cardinality note).
 */
const KNOWN_CLIENTS = [
  'claude-desktop',
  'claude-code',
  'claude-ai',
  'cursor',
  'cline',
  'continue',
  'windsurf',
  'zed',
  'vscode',
  'visual-studio-code',
  'mcp-inspector',
  'inspector',
  'librechat',
  'goose',
  'openai',
  'langchain',
  'n8n',
  'test-client'
]

const MAX_LABEL_LENGTH = 64

/** Lowercase, collapse separators, strip anything that is not `[a-z0-9._-]`. */
function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .slice(0, MAX_LABEL_LENGTH)
}

/**
 * Map a client-supplied name onto the allowlist, or `other`. Matching is substring-based in both
 * directions so `Claude Desktop 1.2` and `claude-desktop` both land on `claude-desktop`.
 */
export function sanitizeClientName(name: string | undefined): string {
  if (!name) return 'unknown'
  const normalized = normalize(name)
  if (!normalized) return 'unknown'
  const match = KNOWN_CLIENTS.find(
    (known) =>
      normalized === known || normalized.includes(known) || known.includes(normalized)
  )
  return match ?? 'other'
}

/**
 * Versions are free text too. Keep only a leading semver-ish prefix; anything else becomes
 * `other`, which bounds the label without losing the common case.
 *
 * Parsed by hand rather than with a regex: this input is attacker-controlled, and a linear scan
 * has no backtracking behaviour to reason about at all.
 */
export function sanitizeClientVersion(version: string | undefined): string {
  if (!version) return 'unknown'
  const trimmed = version.trim()
  const body = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed

  const parts: string[] = []
  for (const segment of body.split('.', 3)) {
    // Stop at the first non-numeric segment: `1.2.3-beta.1` becomes `1.2`, not `other`.
    if (segment.length === 0 || segment.length > 10) break
    let numeric = ''
    for (const char of segment) {
      if (char < '0' || char > '9') break
      numeric += char
    }
    if (numeric.length === 0) break
    parts.push(numeric)
    if (numeric.length !== segment.length) break
  }

  return parts.length > 0 ? parts.join('.') : 'other'
}

export function sanitizeClient(
  name: string | undefined,
  version: string | undefined
): { clientName: string; clientVersion: string } {
  return {
    clientName: sanitizeClientName(name),
    clientVersion: sanitizeClientVersion(version)
  }
}

/**
 * Client IP, honoring `X-Forwarded-For` only through Express's `trust proxy` setting — reading the
 * header directly would let any caller spoof their identity by setting it.
 */
export function extractClientIp(req: Request): string | undefined {
  const ip = req.ip ?? req.socket?.remoteAddress ?? undefined
  if (!ip) return undefined
  // Normalize IPv4-mapped IPv6 (`::ffff:1.2.3.4`) so the same client hashes consistently.
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

/**
 * Hash of (ip, client name, [port]).
 *
 * Returns `undefined` when the IP is unknown: hashing a constant placeholder would collapse every
 * unidentifiable client onto one shared id and report them as a single user. Contributing nothing
 * to the sketch is the honest answer.
 */
export function deriveUserId(
  ip: string | undefined,
  clientName: string,
  port?: number
): string | undefined {
  if (!ip) return undefined

  const config = telemetryConfig()
  const parts = [ip, clientName]
  if (config.includePortInUserId && typeof port === 'number') parts.push(String(port))

  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}
