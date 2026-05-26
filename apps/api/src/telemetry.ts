/**
 * apps/api telemetry wiring.
 *
 * Calls bootTelemetry first (must be the earliest import side effect in
 * server.ts so OTel patches the modules we register later). Exposes
 * per-service meters / tracers used by route handlers.
 *
 * @module apps/api/telemetry
 */

import { metrics, trace } from '@opentelemetry/api';
import {
  bootTelemetry,
  shutdownTelemetry,
  configureOutcomes,
  registerHttpInstrumentations,
} from '@aggregator-dpg/telemetry';
import { config, telemetryConfig } from './config.js';

const SERVICE_NAME = 'aggregator-api';

/**
 * Boots OTel telemetry for the aggregator-api service.
 *
 * Must be called before any Fastify plugins or route handlers are
 * registered so that auto-instrumentation patches are applied first.
 * Registers HTTP instrumentations (Fastify + undici) and configures
 * the outcomes event client when credentials are present in config.
 *
 * @returns Resolves when the OTel SDK has started and all
 *   instrumentations are registered.
 */
export async function bootApiTelemetry(): Promise<void> {
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
export const shutdownApiTelemetry = shutdownTelemetry;

/** OTel tracer scoped to the aggregator-api service. */
export const tracer = trace.getTracer(SERVICE_NAME);

/** OTel meter scoped to the aggregator-api service. */
export const meter = metrics.getMeter(SERVICE_NAME);

/** Total count of HTTP requests received by the API. */
export const apiRequests = meter.createCounter('api.requests.total', {
  description: 'HTTP requests received',
});

/** Distribution of HTTP request durations in milliseconds. */
export const apiLatencyMs = meter.createHistogram('api.request.duration_ms', { unit: 'ms' });

/** Total count of HTTP 5xx error responses. */
export const api5xx = meter.createCounter('api.5xx.total', {
  description: 'HTTP 5xx responses',
});

/** Total count of jobs enqueued by the API onto BullMQ queues. */
export const queueEnqueueTotal = meter.createCounter('api.queue.enqueue.total');
