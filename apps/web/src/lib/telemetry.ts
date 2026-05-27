/**
 * apps/web telemetry wiring (Next.js BFF, Node runtime only).
 *
 * Exports bootWebTelemetry + shutdown + per-service tracer/meter/instruments.
 * Browser-side OTel is out of scope for v1 — see design §5.1.
 *
 * @module apps/web/lib/telemetry
 */

import { metrics, trace } from '@opentelemetry/api';
import {
  bootTelemetry,
  shutdownTelemetry,
  registerHttpInstrumentations,
} from '@aggregator-dpg/telemetry';

const SERVICE_NAME = 'aggregator-web';

/**
 * Boots OTel telemetry for the aggregator-web service.
 *
 * Must be called before any route module so auto-instrumentation patches
 * apply first. Called from the Next.js `instrumentation.ts` entry point
 * on the Node.js server runtime only.
 *
 * @returns Resolves when the OTel SDK has started and all
 *   instrumentations are registered.
 */
export async function bootWebTelemetry(): Promise<void> {
  await bootTelemetry({
    serviceName: SERVICE_NAME,
    serviceVersion: process.env.APP_VERSION ?? 'dev',
    deploymentEnvironment: process.env.NODE_ENV ?? 'development',
    config: {
      otel: {
        collector_endpoint: process.env.OTEL_COLLECTOR_ENDPOINT ?? 'http://otel-collector:4317',
        protocol: 'grpc',
        sample_rate: Number(process.env.OTEL_SAMPLE_RATE ?? 0.1),
        export_interval_ms: 5000,
        timeout_ms: 10000,
      },
      pii_fields_excluded: ['user_message', 'phone', 'email'],
    },
  });
  registerHttpInstrumentations();
}

/**
 * Gracefully shuts down the OTel SDK.
 *
 * Flushes all pending spans, metrics, and log records. Call on SIGTERM /
 * SIGINT before the process exits to avoid losing buffered telemetry.
 *
 * @returns Resolves when the SDK has flushed and shut down.
 */
export const shutdownWebTelemetry = shutdownTelemetry;

/** OTel tracer scoped to the aggregator-web service. */
export const tracer = trace.getTracer(SERVICE_NAME);

/** OTel meter scoped to the aggregator-web service. */
export const meter = metrics.getMeter(SERVICE_NAME);

/** Distribution of Time-to-First-Byte values for server-rendered pages, in milliseconds. */
export const webTtfbMs = meter.createHistogram('web.ttfb_ms', { unit: 'ms' });

/** Total count of requests handled by the Next.js BFF. */
export const webRequests = meter.createCounter('web.requests.total');

/** Distribution of BFF → upstream API proxy call durations, in milliseconds. */
export const webProxyDurationMs = meter.createHistogram('web.api_proxy.duration_ms', {
  unit: 'ms',
});
