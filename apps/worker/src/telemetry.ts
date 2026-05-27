/**
 * apps/worker telemetry wiring.
 *
 * Calls bootTelemetry first (must be the earliest import side effect in
 * main.ts so OTel patches the modules we register later). Exposes
 * per-service tracer + metric instruments used by job processors.
 *
 * Important: metric instruments are constructed INSIDE `bootWorkerTelemetry()`
 * AFTER the SDK's MeterProvider is registered. See `apps/api/src/telemetry.ts`
 * for the rationale.
 *
 * @module apps/worker/telemetry
 */

import {
  metrics,
  trace,
  type Counter,
  type Histogram,
  type MetricAttributes,
} from '@opentelemetry/api';
import {
  bootTelemetry,
  shutdownTelemetry,
  configureOutcomes,
  registerHttpInstrumentations,
} from '@aggregator-dpg/telemetry';
import { config, telemetryConfig } from './config.js';

const SERVICE_NAME = 'aggregator-worker';

let _bulkRowsTotal: Counter | undefined;
let _bulkRowDurationMs: Histogram | undefined;
let _signalStackCalls: Counter | undefined;
let _signalStackDurationMs: Histogram | undefined;
let _jobDurationMs: Histogram | undefined;

/**
 * Boots OTel telemetry for the aggregator-worker service.
 *
 * Constructs the metric instruments AFTER bootTelemetry completes so they
 * bind to the real MeterProvider rather than the default Noop.
 *
 * @returns Resolves when the OTel SDK has started and all
 *   instrumentations are registered.
 */
export async function bootWorkerTelemetry(): Promise<void> {
  await bootTelemetry({
    serviceName: SERVICE_NAME,
    serviceVersion: config.APP_VERSION,
    deploymentEnvironment: config.NODE_ENV,
    config: telemetryConfig,
  });
  registerHttpInstrumentations();
  configureOutcomes({
    ...(telemetryConfig.outcomes_svc_url !== undefined && {
      outcomesSvcUrl: telemetryConfig.outcomes_svc_url,
    }),
    ...(telemetryConfig.outcomes_hmac_key_id !== undefined && {
      hmacKeyId: telemetryConfig.outcomes_hmac_key_id,
    }),
    ...(telemetryConfig.outcomes_hmac_secret !== undefined && {
      hmacSecret: telemetryConfig.outcomes_hmac_secret,
    }),
  });

  // NOW that the SDK is in place, get the real meter and create instruments.
  const meter = metrics.getMeter(SERVICE_NAME);
  _bulkRowsTotal = meter.createCounter('worker.bulk_rows.total', {
    description: 'Bulk rows processed (status label)',
  });
  _bulkRowDurationMs = meter.createHistogram('worker.bulk_row.duration_ms', { unit: 'ms' });
  _signalStackCalls = meter.createCounter('signalstack.calls.total');
  _signalStackDurationMs = meter.createHistogram('signalstack.duration_ms', { unit: 'ms' });
  _jobDurationMs = meter.createHistogram('worker.job.duration_ms', { unit: 'ms' });
}

/**
 * Gracefully shuts down the OTel SDK.
 *
 * Flushes all pending spans, metrics, and log records. Call on SIGTERM /
 * SIGINT before the process exits to avoid losing buffered telemetry.
 */
export const shutdownWorkerTelemetry = shutdownTelemetry;

/** OTel tracer scoped to the aggregator-worker service. */
export const tracer = trace.getTracer(SERVICE_NAME);

/** Total count of bulk rows processed, broken down by status label. */
export const bulkRowsTotal = {
  add(value: number, attributes?: MetricAttributes): void {
    _bulkRowsTotal?.add(value, attributes);
  },
};

/** Distribution of per-row processing durations in milliseconds. */
export const bulkRowDurationMs = {
  record(value: number, attributes?: MetricAttributes): void {
    _bulkRowDurationMs?.record(value, attributes);
  },
};

/** Total count of SignalStack outbound calls. */
export const signalStackCalls = {
  add(value: number, attributes?: MetricAttributes): void {
    _signalStackCalls?.add(value, attributes);
  },
};

/** Distribution of SignalStack call durations in milliseconds. */
export const signalStackDurationMs = {
  record(value: number, attributes?: MetricAttributes): void {
    _signalStackDurationMs?.record(value, attributes);
  },
};

/** Distribution of overall job processing durations in milliseconds. */
export const jobDurationMs = {
  record(value: number, attributes?: MetricAttributes): void {
    _jobDurationMs?.record(value, attributes);
  },
};
