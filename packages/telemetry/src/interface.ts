/**
 * Public Zod schema and abstract surface for @aggregator-dpg/telemetry.
 *
 * This module is the sole public contract for telemetry configuration consumed
 * by per-service bootstrap (api, worker, web, observability-svc) via BootOptions.
 *
 * Import-restricted by dep-cruiser to only shared-primitives, zod, and node:* —
 * no OTel SDK imports may appear here (enforced by the no-heavy-deps-in-interface rule).
 *
 * @module @aggregator-dpg/telemetry/interface
 */

import { z } from 'zod';

/**
 * Zod schema for the telemetry package configuration.
 *
 * Validates OpenTelemetry collector settings and optional outcomes-service
 * credentials. All numeric fields with defaults match the values documented
 * in docs/telemetry-design.md §7 (sample_rate) and §9 (export_interval_ms).
 *
 * Defaults applied when fields are omitted:
 * - `otel.protocol` — `'grpc'`
 * - `otel.sample_rate` — `0.1` (10 % head sampling)
 * - `otel.export_interval_ms` — `5000` ms
 * - `otel.timeout_ms` — `10000` ms
 * - `pii_fields_excluded` — `[]`
 */
export const TelemetryConfigSchema = z.object({
  /**
   * OpenTelemetry collector connection settings.
   */
  otel: z.object({
    /**
     * OTLP collector endpoint URL (e.g. `http://otel-collector:4317`).
     * Must be a valid URL.
     */
    collector_endpoint: z.string().url(),

    /**
     * Transport protocol for the OTLP exporter.
     * Defaults to `'grpc'`.
     */
    protocol: z.enum(['grpc', 'http']).default('grpc'),

    /**
     * Head-sampling rate in the range [0, 1].
     * `0` drops all spans; `1` keeps all spans.
     * Defaults to `0.1`.
     */
    sample_rate: z.number().min(0).max(1).default(0.1),

    /**
     * How often the periodic exporter flushes spans to the collector, in ms.
     * Defaults to `5000`.
     */
    export_interval_ms: z.number().int().positive().default(5000),

    /**
     * Per-export request timeout in ms.
     * Defaults to `10000`.
     */
    timeout_ms: z.number().int().positive().default(10000),
  }),

  /**
   * Base URL for the outcomes/observability service.
   * When present, business-outcome events are forwarded here.
   */
  outcomes_svc_url: z.string().url().optional(),

  /**
   * HMAC key identifier used for signing outcomes requests.
   * Required only when `outcomes_svc_url` is set.
   */
  outcomes_hmac_key_id: z.string().optional(),

  /**
   * HMAC shared secret for signing outcomes requests.
   * Never logged — handled exclusively via the audit path.
   */
  outcomes_hmac_secret: z.string().optional(),

  /**
   * List of attribute keys whose values must be redacted before export.
   * Defaults to an empty list.
   */
  pii_fields_excluded: z.array(z.string()).default([]),
});

/**
 * Inferred TypeScript type for the validated telemetry configuration.
 *
 * Use this type throughout the package to pass config objects — never
 * use `z.infer<typeof TelemetryConfigSchema>` directly at call sites.
 */
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;

/**
 * Options supplied to the telemetry bootstrap function at service startup.
 *
 * Services pass this object to `bootstrap()` (exported from the `./bootstrap`
 * subpath) to initialise the OTel SDK, pino logger, and outcomes client.
 */
export interface BootOptions {
  /** Human-readable service name reported as the OTel `service.name` resource attribute. */
  serviceName: string;

  /** SemVer string reported as the OTel `service.version` resource attribute. */
  serviceVersion: string;

  /** Deployment environment label (e.g. `dev`, `staging`, `prod`). */
  deploymentEnvironment: string;

  /** Validated telemetry configuration produced by parsing `TelemetryConfigSchema`. */
  config: TelemetryConfig;
}
