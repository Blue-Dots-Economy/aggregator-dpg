/**
 * apps/api telemetry wiring.
 *
 * Calls bootTelemetry first (must be the earliest import side effect in
 * server.ts so OTel patches the modules we register later). Exposes
 * per-service tracer + metric instruments used by route handlers.
 *
 * Important: metric instruments are constructed INSIDE `bootApiTelemetry()`
 * AFTER the SDK's MeterProvider is registered. OTel JS's `metrics.getMeter()`
 * resolves to the current global provider at call time, so calling it at
 * module load (before boot) returns a NoopMeter and any instruments created
 * on it never emit. We defer creation via lazy holders so the exported
 * `apiRequests`, `apiLatencyMs`, etc. always delegate to the real instruments
 * once boot completes.
 *
 * @module apps/api/telemetry
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

const SERVICE_NAME = 'aggregator-api';

let _apiRequests: Counter | undefined;
let _apiLatencyMs: Histogram | undefined;
let _api5xx: Counter | undefined;
let _queueEnqueueTotal: Counter | undefined;

/**
 * Boots OTel telemetry for the aggregator-api service.
 *
 * Must be called before any Fastify plugins or route handlers are
 * registered so that auto-instrumentation patches are applied first.
 * Constructs the metric instruments AFTER bootTelemetry completes so they
 * bind to the real MeterProvider rather than the default Noop.
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

  // NOW that the SDK is in place, get the real meter and create instruments.
  const meter = metrics.getMeter(SERVICE_NAME);
  _apiRequests = meter.createCounter('api.requests.total', {
    description: 'HTTP requests received',
  });
  _apiLatencyMs = meter.createHistogram('api.request.duration_ms', { unit: 'ms' });
  _api5xx = meter.createCounter('api.5xx.total', { description: 'HTTP 5xx responses' });
  _queueEnqueueTotal = meter.createCounter('api.queue.enqueue.total');
}

/**
 * Gracefully shuts down the OTel SDK.
 *
 * Flushes all pending spans, metrics, and log records. Call on SIGTERM /
 * SIGINT before the process exits to avoid losing buffered telemetry.
 */
export const shutdownApiTelemetry = shutdownTelemetry;

/** OTel tracer scoped to the aggregator-api service. */
export const tracer = trace.getTracer(SERVICE_NAME);

/**
 * Total count of HTTP requests received by the API.
 *
 * Façade that delegates to the real Counter created by bootApiTelemetry.
 * Calls made before boot are silently dropped — same semantics as a
 * Noop counter, but without the noop instrument being permanently bound.
 */
export const apiRequests = {
  add(value: number, attributes?: MetricAttributes): void {
    _apiRequests?.add(value, attributes);
  },
};

/** Distribution of HTTP request durations in milliseconds. */
export const apiLatencyMs = {
  record(value: number, attributes?: MetricAttributes): void {
    _apiLatencyMs?.record(value, attributes);
  },
};

/** Total count of HTTP 5xx error responses. */
export const api5xx = {
  add(value: number, attributes?: MetricAttributes): void {
    _api5xx?.add(value, attributes);
  },
};

/** Total count of jobs enqueued by the API onto BullMQ queues. */
export const queueEnqueueTotal = {
  add(value: number, attributes?: MetricAttributes): void {
    _queueEnqueueTotal?.add(value, attributes);
  },
};
