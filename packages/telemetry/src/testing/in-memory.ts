/**
 * In-memory telemetry recorder used by TelemetryFake.
 *
 * Stores spans and metrics in plain arrays so cross-package tests can
 * assert on the recorded calls without standing up a real OTel provider.
 *
 * Per the testing conventions in this repository, this class is the
 * in-memory implementation that TelemetryFake (the public fake) extends.
 * External test consumers must import through the `./testing` subpath
 * (`@aggregator-dpg/telemetry/testing`), not from this file directly.
 *
 * @module @aggregator-dpg/telemetry/testing
 */

/**
 * Represents a recorded span with its name, attributes, optional events, and status.
 *
 * Used by test code to seed or inspect spans captured during a test run.
 */
export interface SpanFixture {
  /** The span operation name. */
  name: string;
  /** Key-value attributes attached to the span. */
  attributes: Record<string, unknown>;
  /** Optional events recorded within the span. */
  events?: { name: string; attributes?: Record<string, unknown> }[];
  /** Terminal status of the span. */
  status?: 'ok' | 'error';
}

/**
 * Represents a recorded metric data point.
 *
 * Used by test code to seed or inspect metrics captured during a test run.
 */
export interface MetricFixture {
  /** The metric instrument name. */
  name: string;
  /** The numeric value observed or recorded. */
  value: number;
  /** Key-value attributes attached to the metric data point. */
  attributes: Record<string, unknown>;
}

/**
 * In-memory telemetry recorder that stores spans and metrics in plain arrays.
 *
 * Intended to be extended by `TelemetryFake` (the public fake exported from
 * the `./testing` subpath). Do not use this class directly across package
 * boundaries — import `TelemetryFake` from `@aggregator-dpg/telemetry/testing`.
 *
 * @example
 * ```ts
 * const recorder = new InMemoryTelemetry();
 * recorder.recordSpan({ name: 'op', attributes: {} });
 * recorder.recordMetric({ name: 'counter', value: 1, attributes: {} });
 * assert(recorder.spans.length === 1);
 * ```
 */
export class InMemoryTelemetry {
  /** All spans recorded via {@link recordSpan} or pre-loaded via {@link seed}. */
  spans: SpanFixture[] = [];

  /** All metrics recorded via {@link recordMetric} or pre-loaded via {@link seed}. */
  metrics: MetricFixture[] = [];

  /**
   * Records a span into the in-memory store.
   *
   * @param span - The span fixture to record.
   */
  recordSpan(span: SpanFixture): void {
    this.spans.push(span);
  }

  /**
   * Records a metric into the in-memory store.
   *
   * @param metric - The metric fixture to record.
   */
  recordMetric(metric: MetricFixture): void {
    this.metrics.push(metric);
  }

  /**
   * Pre-populates the in-memory store with spans and/or metrics for test setup.
   *
   * Call before the test body, not inside the system under test.
   * Seeding the same entry twice appends — it does not deduplicate.
   *
   * @param data - Optional arrays of spans and/or metrics to insert before the test runs.
   */
  seed(data: { spans?: SpanFixture[]; metrics?: MetricFixture[] }): void {
    for (const s of data.spans ?? []) this.spans.push(s);
    for (const m of data.metrics ?? []) this.metrics.push(m);
  }
}
