/**
 * Histogram bucket views for the telemetry package.
 *
 * Defines per-instrument bucket boundaries that the OTel MeterProvider applies
 * when named histogram instruments are created. The OTel SDK's default
 * exponential buckets are poorly suited to sub-second hot-path latency
 * analysis; design §4.2 specifies boundaries tuned for each histogram family's
 * observed latency distribution.
 *
 * IMPORTANT: view definitions must be registered with the MeterProvider
 * **before** the first instrument bearing the matching name is created,
 * otherwise the SDK falls back to default buckets.
 *
 * @module telemetry/views
 * @package @aggregator-dpg/telemetry
 */
import { ExplicitBucketHistogramAggregation, View } from '@opentelemetry/sdk-metrics';

/** Internal descriptor for a histogram instrument and its bucket boundaries. */
interface HistogramFamily {
  /** OTel instrument name this view applies to. */
  instrumentName: string;
  /** Explicit bucket upper boundaries in milliseconds (design §4.2). */
  boundaries: number[];
}

/**
 * Per-instrument bucket boundaries for every histogram family defined in
 * design §4.2.
 *
 * Each entry maps an OTel instrument name to the explicit bucket boundaries
 * (in milliseconds) that best represent its expected latency distribution.
 * These boundaries are chosen to provide high resolution in the hot-path
 * range while still capturing long-tail outliers.
 *
 * Pass the result of {@link buildViews} to `MeterProvider` options at
 * startup — before any histogram instrument is created.
 */
export const HISTOGRAM_VIEWS: HistogramFamily[] = [
  {
    instrumentName: 'api.request.duration_ms',
    boundaries: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  },
  {
    instrumentName: 'db.call.duration_ms',
    boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  },
  {
    instrumentName: 'redis.call.duration_ms',
    boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  },
  {
    instrumentName: 'signalstack.duration_ms',
    boundaries: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  },
  {
    instrumentName: 'worker.job.duration_ms',
    boundaries: [100, 500, 1000, 5000, 15000, 60000, 300000, 900000],
  },
  {
    instrumentName: 'worker.bulk_row.duration_ms',
    boundaries: [10, 50, 100, 500, 1000, 5000, 30000],
  },
];

/**
 * Constructs an array of OTel {@link View} objects from {@link HISTOGRAM_VIEWS}.
 *
 * Each `View` pairs an instrument name selector with an
 * `ExplicitBucketHistogramAggregation` configured to the §4.2 boundaries for
 * that family. Min/max recording is enabled on every view so P0 and P100
 * latencies are always available.
 *
 * Register the returned views with `MeterProvider` at startup before any
 * instrument is created:
 *
 * ```ts
 * const provider = new MeterProvider({ views: buildViews(), resource });
 * ```
 *
 * @returns Array of configured `View` instances, one per histogram family.
 */
export function buildViews(): View[] {
  return HISTOGRAM_VIEWS.map(
    (f) =>
      new View({
        instrumentName: f.instrumentName,
        aggregation: new ExplicitBucketHistogramAggregation(f.boundaries, true),
      }),
  );
}
