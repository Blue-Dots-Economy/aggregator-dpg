/**
 * OTel SDK bootstrap for aggregator-dpg services.
 *
 * Reads `OTEL_SDK_DISABLED` first and short-circuits if set — the production
 * kill switch must work without any SDK side effects (design §10.2).
 * Otherwise installs TracerProvider + MeterProvider + LoggerProvider with
 * OTLP gRPC exporters, batch processors sized via BSP env vars (§10.3),
 * and the histogram views from §4.2.
 *
 * @module @aggregator-dpg/telemetry/bootstrap
 * @package @aggregator-dpg/telemetry
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { logs } from '@opentelemetry/api-logs';
import type { BootOptions } from './interface.js';
import { buildResource } from './resource.js';
import { configurePropagator } from './propagator.js';
import { buildViews } from './views.js';

/** Active NodeSDK instance — `undefined` when telemetry has not been booted or has been shut down. */
let sdk: NodeSDK | undefined;

/** Active LoggerProvider — exposed to pino-otel-transport (Task 0.7) via {@link getLoggerProvider}. */
let loggerProvider: LoggerProvider | undefined;

/** Whether telemetry is currently enabled and the SDK is running. */
let enabled = false;

/**
 * Returns `true` when telemetry has been successfully booted and the SDK is
 * active.
 *
 * Returns `false` before `bootTelemetry` is called, after `shutdownTelemetry`
 * completes, or when `OTEL_SDK_DISABLED=true` was set at boot time.
 *
 * @returns Current telemetry enabled state.
 */
export function isTelemetryEnabled(): boolean {
  return enabled;
}

/**
 * Returns the active OTel {@link LoggerProvider} instance, or `undefined` if
 * telemetry has not been booted or has been shut down.
 *
 * Exposed for the pino-otel-transport (Task 0.7) to bridge pino log records
 * into the OTel log pipeline without going through the global registry.
 *
 * @returns The active `LoggerProvider`, or `undefined`.
 */
export function getLoggerProvider(): LoggerProvider | undefined {
  return loggerProvider;
}

/**
 * Boots the OTel SDK for the calling service.
 *
 * Wires together:
 * - A `TracerProvider` backed by an OTLP gRPC exporter with a
 *   `BatchSpanProcessor` whose queue/batch sizes are read from env vars
 *   (`OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`,
 *   `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_EXPORT_TIMEOUT`).
 * - A `MeterProvider` with a `PeriodicExportingMetricReader` and the
 *   §4.2 histogram bucket views.
 * - A `LoggerProvider` with a `BatchLogRecordProcessor`, registered as the
 *   global OTel logger provider.
 * - The W3C composite propagator (traceparent + baggage).
 *
 * The function is idempotent — a second call while the SDK is active returns
 * immediately without creating a second SDK instance.
 *
 * When `OTEL_SDK_DISABLED=true` is set in the environment the function
 * returns immediately without initialising any SDK component (kill switch).
 *
 * @param opts - Service identity and telemetry configuration.
 */
export async function bootTelemetry(opts: BootOptions): Promise<void> {
  if (sdk) return; // idempotent

  if (process.env.OTEL_SDK_DISABLED === 'true') {
    enabled = false;
    return;
  }

  const resource = buildResource({
    serviceName: opts.serviceName,
    serviceVersion: opts.serviceVersion,
    deploymentEnvironment: opts.deploymentEnvironment,
  });

  const traceExporter = new OTLPTraceExporter({ url: opts.config.otel.collector_endpoint });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: opts.config.otel.collector_endpoint }),
    exportIntervalMillis: opts.config.otel.export_interval_ms,
  });

  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(opts.config.otel.sample_rate),
  });

  sdk = new NodeSDK({
    resource,
    sampler,
    spanProcessors: [
      new BatchSpanProcessor(traceExporter, {
        maxQueueSize: Number(process.env.OTEL_BSP_MAX_QUEUE_SIZE ?? 2048),
        maxExportBatchSize: Number(process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE ?? 512),
        scheduledDelayMillis: Number(process.env.OTEL_BSP_SCHEDULE_DELAY ?? 5000),
        exportTimeoutMillis: Number(process.env.OTEL_BSP_EXPORT_TIMEOUT ?? 30000),
      }),
    ],
    metricReader,
    views: buildViews(),
  });

  loggerProvider = new LoggerProvider({ resource });
  loggerProvider.addLogRecordProcessor(
    new BatchLogRecordProcessor(new OTLPLogExporter({ url: opts.config.otel.collector_endpoint })),
  );
  logs.setGlobalLoggerProvider(loggerProvider);

  sdk.start();
  configurePropagator();
  enabled = true;
}

/**
 * Gracefully shuts down the active OTel SDK.
 *
 * Flushes all pending spans, metrics, and log records before resolving.
 * After this call `isTelemetryEnabled()` returns `false` and a subsequent
 * `bootTelemetry()` call will re-initialise the SDK cleanly — allowing test
 * suites to boot and tear down telemetry per-test without leaking state.
 *
 * Safe to call when telemetry was never booted or when `OTEL_SDK_DISABLED`
 * was set — in those cases it is a no-op.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    await loggerProvider?.shutdown();
  } finally {
    sdk = undefined;
    loggerProvider = undefined;
    enabled = false;
  }
}
