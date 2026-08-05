/**
 * OpenTelemetry bootstrap.
 *
 * Loaded via `node --import ./dist/telemetry/otel.js` (see the `start` script) so the SDK is
 * running **before** `express`/`http` are imported — HTTP auto-instrumentation cannot patch
 * modules that are already loaded (plan §3.3).
 *
 * Importing this module is always safe: `initTelemetry()` self-disables unless the process is in
 * SSE mode with an OTLP endpoint configured, so the stdio path pays nothing and emits nothing.
 */
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node'
import { HostMetrics } from '@opentelemetry/host-metrics'
import { randomUUID } from 'node:crypto'

import { telemetryConfig, type TelemetryConfig } from './config.js'
import { telemetryLog } from './log.js'

let sdk: NodeSDK | undefined
let started = false

export function initTelemetry(
  env: NodeJS.ProcessEnv = process.env
): TelemetryConfig | undefined {
  if (started) return telemetryConfig()
  started = true

  const config = telemetryConfig()

  if (!config.enabled) {
    // Silent on the stdio path: that is the default mode, not a misconfiguration worth logging
    // on every local invocation.
    if (config.disabledReason && !config.disabledReason.includes('SSE-only')) {
      telemetryLog(`disabled — ${config.disabledReason}`)
    }
    return config
  }

  try {
    const resource = resourceFromAttributes({
      'service.name': config.serviceName,
      'service.version': config.serviceVersion,
      'deployment.environment': config.environment,
      'service.instance.id': randomUUID()
    })

    sdk = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter(),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 60_000)
      }),
      instrumentations: [
        new HttpInstrumentation({
          // The MCP transport is long-lived streaming; tracing every chunk is noise.
          ignoreIncomingRequestHook: (req) => req.url === '/health'
        }),
        new ExpressInstrumentation(),
        // V8 heap used/limit, event-loop delay and GC. `host-metrics` covers process/system
        // memory and CPU but not these — the heap-headroom panel needs the V8 limit, which
        // reflects `--max-old-space-size`.
        new RuntimeNodeInstrumentation()
      ]
    })

    sdk.start()

    const hostMetrics = new HostMetrics({ name: config.serviceName })
    hostMetrics.start()

    telemetryLog(
      `enabled — exporting to ${config.endpoint} as service.name=${config.serviceName}`
    )

    const stop = () => {
      sdk
        ?.shutdown()
        .catch((error) => telemetryLog('shutdown failed', error))
        .finally(() => undefined)
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  } catch (error) {
    // A telemetry failure must never take the MCP server down.
    telemetryLog('failed to initialize — continuing without telemetry', error)
  }

  return config
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return
  try {
    await sdk.shutdown()
  } catch (error) {
    telemetryLog('shutdown failed', error)
  }
}

// Auto-start when loaded via `--import`. Guarded so importing the module from a test or from
// application code does not start a second SDK.
initTelemetry()
