/**
 * Runtime configuration for the worker process. Mirrors the shape of the
 * API config but only loads the variables the worker actually consumes.
 */

import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z
    .string()
    .default('postgres://aggregator:aggregator-dev@localhost:5433/aggregator'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // ─── Object storage ─────────────────────────────────────────────────────
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('aggregator-bulk-uploads'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // ─── Schema loader ──────────────────────────────────────────────────────
  /** Absolute or relative path to `config/schemas/`. */
  SCHEMA_ROOT_DIR: z.string().default('./config/schemas'),

  // ─── File Processor limits ──────────────────────────────────────────────
  BULK_MAX_ROWS: z.coerce.number().int().positive().default(10000),
  BULK_MAX_ROW_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(64 * 1024),

  // ─── Worker concurrency ─────────────────────────────────────────────────
  BULK_FILE_PROCESS_CONCURRENCY: z.coerce.number().int().positive().default(2),
  BULK_ROW_PROCESS_CONCURRENCY: z.coerce.number().int().positive().default(10),
  // Concurrency caps how many DIFFERENT uploads can finalise in parallel
  // across the worker process. BullMQ jobId dedupe (`${uploadId}:finalise`)
  // already guarantees one finaliser per upload.
  BULK_FINALISE_CONCURRENCY: z.coerce.number().int().positive().default(2),

  // ─── Link metrics aggregator ────────────────────────────────────────────
  /**
   * Cron interval (ms) for the link-metrics rollup tick. Default 1 min so
   * public-form submissions surface on the aggregator dashboard quickly.
   * Override via env for higher-throughput deployments where 1 min creates
   * too much DB churn.
   */
  LINK_METRICS_ROLLUP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 1000),

  // ─── Watchdog cron ──────────────────────────────────────────────────────
  /** Cron interval (ms) for the stuck-job watchdog tick. Default 1 hour. */
  WATCHDOG_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),

  // ─── SignalStack outward push ───────────────────────────────────────────
  /** Base URL of the signalstack API. When unset, signalstack push is disabled. */
  SIGNALSTACK_BASE_URL: z.string().url().optional(),
  /** Admin api-key for signalstack onboard. Required when SIGNALSTACK_BASE_URL is set. */
  SIGNALSTACK_ADMIN_KEY: z.string().optional(),
  /** item_network sent on every onboard call. */
  SIGNALSTACK_ITEM_NETWORK: z.string().default('blue_dot'),
  /** Per-request timeout for signalstack onboard calls. */
  SIGNALSTACK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // ─── Telemetry ───────────────────────────────────────────────────────────
  APP_VERSION: z.string().default('dev'),
  OTEL_SDK_DISABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OTEL_COLLECTOR_ENDPOINT: z.string().default('http://otel-collector:4317'),
  OTEL_PROTOCOL: z.enum(['grpc', 'http']).default('grpc'),
  OTEL_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  OTEL_EXPORT_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  OTEL_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  OBS_SVC_URL: z.string().url().optional(),
  OBS_HMAC_KEY_ID: z.string().optional(),
  OBS_HMAC_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse(process.env);

export const telemetryConfig = {
  otel: {
    collector_endpoint: config.OTEL_COLLECTOR_ENDPOINT,
    protocol: config.OTEL_PROTOCOL,
    sample_rate: config.OTEL_SAMPLE_RATE,
    export_interval_ms: config.OTEL_EXPORT_INTERVAL_MS,
    timeout_ms: config.OTEL_TIMEOUT_MS,
  },
  ...(config.OBS_SVC_URL !== undefined && { outcomes_svc_url: config.OBS_SVC_URL }),
  ...(config.OBS_HMAC_KEY_ID !== undefined && { outcomes_hmac_key_id: config.OBS_HMAC_KEY_ID }),
  ...(config.OBS_HMAC_SECRET !== undefined && { outcomes_hmac_secret: config.OBS_HMAC_SECRET }),
  pii_fields_excluded: ['user_message', 'phone', 'email'],
};
