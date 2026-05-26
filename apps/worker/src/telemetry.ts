/**
 * apps/worker telemetry wiring.
 *
 * Calls bootTelemetry first (must be the earliest import side effect in
 * main.ts so OTel patches the modules we register later). Exposes
 * per-service meters / tracers used by job processors.
 *
 * @module apps/worker/telemetry
 */

import { metrics, trace } from '@opentelemetry/api';
import {
  bootTelemetry,
  shutdownTelemetry,
  configureOutcomes,
  registerHttpInstrumentations,
} from '@aggregator-dpg/telemetry';
import { config, telemetryConfig } from './config.js';

const SERVICE_NAME = 'aggregator-worker';

/**
 * Boots OTel telemetry for the aggregator-worker service.
 *
 * Must be called before any job processors or queue consumers are
 * registered so that auto-instrumentation patches are applied first.
 * Registers HTTP instrumentations (undici) and configures the outcomes
 * event client when credentials are present in config.
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
}

/**
 * Gracefully shuts down the OTel SDK.
 *
 * Flushes all pending spans, metrics, and log records. Call on SIGTERM /
 * SIGINT before the process exits to avoid losing buffered telemetry.
 *
 * @returns Resolves when the SDK has flushed and shut down.
 */
export const shutdownWorkerTelemetry = shutdownTelemetry;

/** OTel tracer scoped to the aggregator-worker service. */
export const tracer = trace.getTracer(SERVICE_NAME);

/** OTel meter scoped to the aggregator-worker service. */
export const meter = metrics.getMeter(SERVICE_NAME);

/** Total count of bulk rows processed, broken down by status label. */
export const bulkRowsTotal = meter.createCounter('worker.bulk_rows.total', {
  description: 'Bulk rows processed (status label)',
});

/** Distribution of per-row processing durations in milliseconds. */
export const bulkRowDurationMs = meter.createHistogram('worker.bulk_row.duration_ms', {
  unit: 'ms',
});

/** Total count of SignalStack outbound calls. */
export const signalStackCalls = meter.createCounter('signalstack.calls.total');

/** Distribution of SignalStack call durations in milliseconds. */
export const signalStackDurationMs = meter.createHistogram('signalstack.duration_ms', {
  unit: 'ms',
});

/** Distribution of overall job processing durations in milliseconds. */
export const jobDurationMs = meter.createHistogram('worker.job.duration_ms', { unit: 'ms' });
