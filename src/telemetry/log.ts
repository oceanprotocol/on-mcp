/**
 * Telemetry logging.
 *
 * **Never writes to stdout.** In stdio mode stdout is the JSON-RPC channel, and one stray write
 * corrupts the protocol stream.
 *
 * Appends to `debug.log` directly rather than going through `console.error`. `index.ts` redirects
 * `console.error` into `debug.log`, but only once *it* has loaded — and the OTel bootstrap runs
 * before that by design (`node --import`), so a bootstrap line routed through `console.error`
 * would land on the real stderr while every later line landed in the file. Writing to the file
 * directly makes the destination the same regardless of load order, which is what lets
 * `verify-telemetry.sh` and the troubleshooting guide say "grep debug.log" and be right.
 */
import { appendFileSync } from 'node:fs'

const LOG_FILE = 'debug.log'

export function telemetryLog(message: string, error?: unknown): void {
  const suffix =
    error === undefined
      ? ''
      : ` — ${error instanceof Error ? error.message : String(error)}`
  const line = `[telemetry] ${message}${suffix}\n`

  try {
    appendFileSync(LOG_FILE, line)
  } catch {
    // Read-only filesystem or a missing working directory. Fall back to stderr — still never
    // stdout — rather than losing the only signal that telemetry failed to start.
    process.stderr.write(line)
  }
}
