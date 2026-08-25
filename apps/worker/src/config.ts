/**
 * Runtime configuration for the worker process. Mirrors the shape of the
 * API config but only loads the variables the worker actually consumes.
 */

import { z } from 'zod';
import {
  assertSignalStackClientIdentity,
  assertTlsPosture,
  signalStackConfigFields,
} from '@aggregator-dpg/shared-primitives/config';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** Deployment environment; falls back to NODE_ENV when unset. */
  INSTANCE_ENV: z.enum(['development', 'staging', 'production']).optional(),
  /**
   * Observed ONLY so the startup guard can reject the insecure `0` value in
   * production. Node reads this directly from process.env for its TLS
   * behaviour — do not re-derive TLS posture from this field elsewhere. Kept
   * a free string (not an enum) because Node treats only the exact value `'0'`
   * as "disable"; any other value (empty, `'true'`, unset) leaves verification
   * on, and an enum would crash-parse those benign values.
   */
  NODE_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Postgres connection string. Deliberately has **no default** — the URL
   * carries credentials, so embedding one in source would ship a usable
   * secret and mask a misconfigured deploy behind a silent fallback to
   * localhost. Startup fails when it is unset.
   */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL must be set'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** Liveness endpoint port, see health.ts. */
  HEALTH_PORT: z.coerce.number().int().positive().default(8080),

  // ─── Object storage ─────────────────────────────────────────────────────
  S3_ENDPOINT: z.string().optional(),
  /**
   * Browser-reachable S3 host used ONLY to mint pre-signed URLs (the export
   * download link is clicked in a browser/email client, which cannot resolve
   * the internal `S3_ENDPOINT` inside docker). Pre-signed URLs encode the
   * endpoint, so they must be signed against the public host. Falls back to
   * `S3_ENDPOINT` when unset (single-host dev). Mirrors the API's field.
   */
  S3_PUBLIC_ENDPOINT: z.string().optional(),
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

  /**
   * TTL (seconds) applied to every per-upload Redis key (`bu:{id}:*`, which
   * includes the raw participant CSV in `:lines` and error rows in `:errors`).
   * A safety net so participant PII cannot persist indefinitely when an upload
   * fails or is abandoned before `bulk-finalise` deletes the keys. Must comfortably
   * exceed the longest expected processing time (the stuck-job watchdog kills
   * in-flight uploads after 30 min). Default 24h.
   */
  BULK_UPLOAD_REDIS_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

  // ─── Worker role selection ──────────────────────────────────────────────
  /**
   * Comma-separated subset of consumer roles this process runs:
   * `file`, `row`, `finalise`, `cron`. Unset / empty / `all` runs everything
   * (single-process default). Run `file` in its own deployment to isolate the
   * CPU-sensitive parser from the other consumers.
   */
  WORKER_ROLES: z.string().optional(),

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
  // Base + Keycloak-bearer credential fields are shared with the api via
  // @aggregator-dpg/shared-primitives/config.
  ...signalStackConfigFields,
  /**
   * Keycloak base URL for the bearer token grant. The worker has no OIDC
   * login of its own (no acting-org header, no user session) — these two
   * vars exist solely to mint the service token.
   */
  KEYCLOAK_URL: z.string().optional(),
  KEYCLOAK_REALM: z.string().optional(),

  // ─── Campaign PII export (aggregator-dpg#579) ───────────────────────────
  // Recipient is the requesting aggregator's email, resolved by the API and
  // carried on the job — not a worker env.
  /**
   * Pre-signed GET TTL (seconds) for the export CSV link. Default 1 day (86400).
   * Keep in step with the S3 lifecycle rule that deletes the file at expiry
   * (bluedots-automation `global.campaignExportExpiryDays` = this ÷ 86400), so
   * the link and the file expire together.
   */
  EXPORT_URL_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  /** How many campaign-process jobs this process runs in parallel. Default 2. */
  CAMPAIGN_EXPORT_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /** Items per Signals decrypt chunk (bounds request size + gives heartbeat cadence). */
  CAMPAIGN_DECRYPT_CHUNK: z.coerce.number().int().positive().default(500),
  /**
   * Export field-set. `contact` = the three canonical contact fields
   * (name/email/phone) only; `full` = the full decrypted item_state (variable
   * columns). Default `contact`.
   */
  CAMPAIGN_EXPORT_FIELDS: z.enum(['contact', 'full']).default('contact'),
  /**
   * Who receives the export link. `requester` (default) sends it to the user
   * who made the request (the job's `requested_by`, resolved from the verified
   * token by the API). `network_admin` sends it to
   * `EXPORT_NETWORK_ADMIN_EMAIL` instead — a deployment-level override, never
   * caller-controlled.
   */
  CAMPAIGN_EXPORT_RECIPIENT: z.enum(['requester', 'network_admin']).default('requester'),
  /** Recipient used when CAMPAIGN_EXPORT_RECIPIENT=network_admin. */
  EXPORT_NETWORK_ADMIN_EMAIL: z.string().optional(),
  /**
   * A campaign job whose `last_progress_at` is older than this (seconds) is
   * treated as stalled by the watchdog and failed. Default 900 (15 min).
   */
  CAMPAIGN_STALL_SECONDS: z.coerce.number().int().positive().default(900),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse(process.env);
assertTlsPosture(config);
assertSignalStackClientIdentity(config);
