/**
 * Telemetry configuration, parsed once from the environment.
 *
 * Scope is deliberately narrow (plan §3.3): telemetry is a **no-op unless the process is running
 * the hosted SSE transport AND an OTLP endpoint is configured**. The stdio transport owns stdout as
 * its JSON-RPC channel, so nothing here may ever run there — see `docs/telemetry/README.md`.
 */

export type TelemetryConfig = {
  /** Master switch: SSE transport + an OTLP endpoint + not explicitly disabled. */
  enabled: boolean
  /** Why telemetry is off, for a one-line startup log. `undefined` when enabled. */
  disabledReason?: string
  /**
   * Machine-readable form of `disabledReason`. Callers branch on this rather than substring-matching
   * the human text — `stdio` is the normal default and must stay silent at startup.
   */
  disabledBy?: 'transport' | 'endpoint' | 'switch'
  endpoint?: string
  serviceName: string
  serviceVersion: string
  environment: string
  /**
   * Optional `ocean.network` resource attribute (from `OCEAN_NETWORK_LABEL`), so a central
   * Collector shared with `ocean-node` / `ocean-node-bootstrap` fleets can group series by network.
   * Undefined by default — absent from the resource rather than emitted empty.
   */
  networkLabel?: string
  /** Experimental: fold the client source port into `user.id` (plan §2 — leave off). */
  includePortInUserId: boolean
  /**
   * Optional secret mixed into `user.id`. **Absent by default, and the default is unsalted.**
   *
   * Unsalted keeps identity stable with zero configuration, at the cost of being brute-forceable
   * back to an IP (small input space). Setting this makes `user.id` genuinely non-invertible — but
   * it then becomes a value you must keep stable forever and identical across replicas, because it
   * *defines* identity continuity. Rotating or losing it re-identifies every user as new.
   */
  userIdSalt?: string
  /**
   * Express `trust proxy` setting, so `req.ip` is the real client behind a reverse proxy.
   *
   * Union type on purpose: Express treats a **number** ("trust N hops") and a **boolean** ("trust
   * everything / nothing") completely differently from a string, and env vars only ever arrive as
   * strings. See `parseTrustProxy`.
   */
  trustProxy: string | number | boolean
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

/**
 * Positive **integer** milliseconds, or the fallback.
 *
 * `Number(env.X ?? d)` is not equivalent: an unset var is fine, but `X=""` yields `0` and `X=abc`
 * yields `NaN`. Both then reach an OTel interval as a busy-loop or an immediate throw, and neither
 * is what the operator meant by a typo.
 *
 * Integrality is part of the contract, not pedantry: `0.1` is finite and positive, so a
 * positivity-only check would accept it as a **0.1 ms export interval** — a busy loop, which is the
 * exact failure this helper exists to prevent.
 */
export function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return parsed
}

/**
 * Coerce `TRUST_PROXY` into the type Express actually wants.
 *
 * This is not cosmetic. Express (via `proxy-addr`) dispatches on the *runtime type*, and env vars
 * are always strings, so passing the raw value through breaks two of the documented forms:
 *
 *  - `TRUST_PROXY=true` → `proxy-addr` tries to parse `"true"` as an IP and **throws**
 *    `invalid IP address: true`, taking down SSE startup.
 *  - `TRUST_PROXY=1` → parsed as an *IP literal* rather than a hop count. It does not throw; it
 *    simply never matches, so `X-Forwarded-For` is ignored and every client collapses onto the
 *    proxy's address. That is silent, and it breaks precisely the thing this setting exists to
 *    protect — the unique-user estimate.
 *
 * Anything else (`loopback`, `uniquelocal`, an IP, a CIDR, a comma-separated list) is already the
 * string form Express expects and is passed through untouched.
 */
export function parseTrustProxy(value: string | undefined): string | number | boolean {
  const raw = value?.trim()
  // Empty string would also throw in proxy-addr, so it falls back rather than crashing.
  if (!raw) return 'loopback'

  const lowered = raw.toLowerCase()
  if (lowered === 'true') return true
  if (lowered === 'false') return false

  // Hop count. Guarded to non-negative integers: `proxy-addr` treats a number as "trust the first
  // N hops", and a float or negative would silently trust nothing.
  if (/^\d+$/.test(raw)) return Number(raw)

  return raw
}

export function loadTelemetryConfig(
  env: NodeJS.ProcessEnv = process.env
): TelemetryConfig {
  const transport = (env.MCP_TRANSPORT ?? 'stdio').toLowerCase()
  const mode = (env.MCP_TELEMETRY_ENABLED ?? 'auto').toLowerCase()

  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || undefined
  const metricsEndpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim() || undefined

  /**
   * We always export **both** signals, and the OTel exporters resolve their endpoint independently
   * — falling back to `http://localhost:4318/v1/{traces,metrics}` when their own var is unset, with
   * no error. So a single signal-specific endpoint is not enough to enable: it would report
   * "enabled", log that one endpoint, and ship the other signal into a localhost void.
   *
   * Enable on the base endpoint, or on both signal endpoints together.
   */
  const endpoint =
    baseEndpoint ??
    (tracesEndpoint && metricsEndpoint
      ? `${tracesEndpoint} (traces), ${metricsEndpoint} (metrics)`
      : undefined)

  const base = {
    endpoint,
    serviceName: env.OTEL_SERVICE_NAME ?? 'ocean-mcp',
    serviceVersion: env.OTEL_SERVICE_VERSION ?? '0.0.1',
    environment: env.DEPLOYMENT_ENVIRONMENT ?? env.NODE_ENV ?? 'development',
    networkLabel: env.OCEAN_NETWORK_LABEL?.trim() || undefined,
    includePortInUserId: readBool(env.MCP_TELEMETRY_USER_ID_INCLUDE_PORT, false),
    userIdSalt: env.MCP_TELEMETRY_USER_ID_SALT?.trim() || undefined,
    trustProxy: parseTrustProxy(env.TRUST_PROXY)
  }

  if (mode === 'false' || mode === 'off' || mode === '0') {
    return {
      ...base,
      enabled: false,
      disabledBy: 'switch',
      disabledReason: 'MCP_TELEMETRY_ENABLED is off'
    }
  }
  if (transport !== 'sse') {
    return {
      ...base,
      enabled: false,
      disabledBy: 'transport',
      disabledReason: `transport is "${transport}", telemetry is SSE-only`
    }
  }
  if (!endpoint) {
    return {
      ...base,
      enabled: false,
      disabledBy: 'endpoint',
      disabledReason:
        'OTEL_EXPORTER_OTLP_ENDPOINT is not set (or set both ' +
        'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and OTEL_EXPORTER_OTLP_METRICS_ENDPOINT)'
    }
  }

  return { ...base, enabled: true }
}

let cached: TelemetryConfig | undefined

/**
 * Memoized config for the runtime modules (`instrumentTools`, `sessionTracker`, `identity`, …).
 *
 * Deliberately lives here rather than in `otel.ts`: this module is side-effect-free, so importing
 * it from `index.ts` cannot pull the OTel SDK into the import graph ahead of `express` and defeat
 * the `--import` bootstrap ordering (plan §3.3).
 */
export function telemetryConfig(): TelemetryConfig {
  if (!cached) cached = loadTelemetryConfig()
  return cached
}

/** Test-only: drop the memoized config so a test can re-parse a mutated environment. */
export function resetTelemetryConfigForTest(): void {
  cached = undefined
}
