/**
 * Mocha root setup (required first by `.mocharc.json`).
 *
 * Registers in-memory OTel providers **before any test module loads**. This ordering is not
 * optional: `telemetry/metrics.ts` resolves its meter once at module load, and the API hands out
 * permanent no-op instruments when no global provider is registered yet. Since existing suites
 * (e.g. `escrowPreflight.test.ts`) transitively import the telemetry modules, registering here is
 * the only point guaranteed to run first.
 *
 * Nothing leaves the process: no exporter, no network.
 */
import { metrics, trace } from '@opentelemetry/api'
import {
  type CollectionResult,
  type DataPoint,
  MeterProvider,
  MetricReader
} from '@opentelemetry/sdk-metrics'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan
} from '@opentelemetry/sdk-trace-base'

/** A reader that never exports on its own — tests pull with `collect()`. */
class TestMetricReader extends MetricReader {
  protected onShutdown(): Promise<void> {
    return Promise.resolve()
  }

  protected onForceFlush(): Promise<void> {
    return Promise.resolve()
  }
}

const reader = new TestMetricReader()
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }))

export const spanExporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] })
)

type AnyDataPoint = DataPoint<number | { count: number; sum?: number }>

function collect(): Promise<CollectionResult> {
  return reader.collect()
}

function attributesMatch(
  point: AnyDataPoint,
  expected: Record<string, unknown> | undefined
): boolean {
  if (!expected) return true
  return Object.entries(expected).every(
    ([key, value]) => (point.attributes as Record<string, unknown>)[key] === value
  )
}

async function pointsFor(name: string): Promise<AnyDataPoint[]> {
  const { resourceMetrics } = await collect()
  const points: AnyDataPoint[] = []
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      if (metric.descriptor.name === name) {
        points.push(...(metric.dataPoints as AnyDataPoint[]))
      }
    }
  }
  return points
}

/** Summed value of every data point of `name` whose attributes are a superset of `attrs`. */
export async function counterValue(
  name: string,
  attrs?: Record<string, unknown>
): Promise<number> {
  const points = await pointsFor(name)
  return points
    .filter((point) => attributesMatch(point, attrs))
    .reduce((total, point) => total + (point.value as number), 0)
}

/** Number of recordings in a histogram matching `attrs` (not the sum of values). */
export async function histogramCount(
  name: string,
  attrs?: Record<string, unknown>
): Promise<number> {
  const points = await pointsFor(name)
  return points
    .filter((point) => attributesMatch(point, attrs))
    .reduce((total, point) => total + ((point.value as { count: number }).count ?? 0), 0)
}

/** Summed values recorded into a histogram matching `attrs` (not the number of recordings). */
export async function histogramSum(
  name: string,
  attrs?: Record<string, unknown>
): Promise<number> {
  const points = await pointsFor(name)
  return points
    .filter((point) => attributesMatch(point, attrs))
    .reduce((total, point) => total + ((point.value as { sum?: number }).sum ?? 0), 0)
}

/** Every attribute key ever recorded on `name` — used to assert nothing leaked. */
export async function attributeKeys(name: string): Promise<string[]> {
  const points = await pointsFor(name)
  const keys = new Set<string>()
  for (const point of points) {
    for (const key of Object.keys(point.attributes)) keys.add(key)
  }
  return [...keys]
}

export function finishedSpans(): ReadableSpan[] {
  return spanExporter.getFinishedSpans()
}

export function resetSpans(): void {
  spanExporter.reset()
}
