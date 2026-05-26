/**
 * apps/observability-svc telemetry wiring.
 *
 * observability-svc emits its own OTel signals (it's still an app —
 * counters like outcome.duplicate_total, etc. land in the same pipeline
 * as the other services). Telemetry boots BEFORE Redis or the Fastify
 * server so its instrumentations patch fetch/HTTP modules.
 *
 * @module observability-svc/telemetry
 * @package @aggregator-dpg/observability-svc
 */

import { metrics } from '@opentelemetry/api';
import {
  bootTelemetry,
  shutdownTelemetry,
  registerHttpInstrumentations,
} from '@aggregator-dpg/telemetry';
import type { AppConfig } from './config.js';

const SERVICE_NAME = 'aggregator-observability-svc';

/**
 * Boots the OTel SDK for observability-svc.
 *
 * Must be called before any Redis or Fastify initialisation so that
 * HTTP auto-instrumentations patch the relevant modules at load time.
 *
 * @param cfg - Validated runtime configuration containing OTel settings.
 * @returns A promise that resolves once the SDK is fully initialised.
 */
export async function bootObsTelemetry(cfg: AppConfig): Promise<void> {
  await bootTelemetry({
    serviceName: SERVICE_NAME,
    serviceVersion: cfg.APP_VERSION,
    deploymentEnvironment: cfg.NODE_ENV,
    config: {
      otel: {
        collector_endpoint: cfg.OTEL_COLLECTOR_ENDPOINT,
        protocol: 'grpc',
        sample_rate: cfg.OTEL_SAMPLE_RATE,
        export_interval_ms: 5000,
        timeout_ms: 10000,
      },
      pii_fields_excluded: [],
    },
  });
  registerHttpInstrumentations();
}

export const shutdownObsTelemetry = shutdownTelemetry;

export const meter = metrics.getMeter(SERVICE_NAME);
