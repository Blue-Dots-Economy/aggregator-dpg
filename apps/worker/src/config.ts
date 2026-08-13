/**
 * Runtime configuration for the worker process. Mirrors the shape of the
 * API config but only loads the variables the worker actually consumes.
 */

import { z } from 'zod';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';

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
  /** Base URL of the signalstack API. When unset, signalstack push is disabled. */
  SIGNALSTACK_BASE_URL: z.string().url().optional(),
  /** Admin api-key for signalstack onboard. Required when SIGNALSTACK_BASE_URL is set. */
  SIGNALSTACK_ADMIN_KEY: z.string().optional(),
  /** item_network sent on every onboard call. */
  SIGNALSTACK_ITEM_NETWORK: z.string().default('blue_dot'),
  /** Per-request timeout for signalstack onboard calls. */
  SIGNALSTACK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /**
   * Phase C of the Keycloak integration plan: which credential
   * `HttpSignalStackWriter` sends. `apikey` (default) is today's
   * `SIGNALSTACK_ADMIN_KEY` header; `bearer` fetches a client-credentials
   * token instead. Must match apps/api's setting — both processes call the
   * same signals instance as the same service identity.
   */
  SIGNALSTACK_AUTH_MODE: z.enum(['apikey', 'bearer']).default('apikey'),
  /**
   * Confidential Keycloak client id for the bearer credential. Must equal this
   * aggregator's signals `organization.slug` — see
   * {@link SIGNALSTACK_ORG_SLUG}. Required when SIGNALSTACK_AUTH_MODE=bearer.
   */
  SIGNALSTACK_CLIENT_ID: z.string().optional(),
  /** Client secret for SIGNALSTACK_CLIENT_ID. Required when SIGNALSTACK_AUTH_MODE=bearer. */
  SIGNALSTACK_CLIENT_SECRET: z.string().optional(),
  /**
   * This aggregator's `organization.slug` on the signals side. When set, boot
   * asserts `SIGNALSTACK_CLIENT_ID` equals it (see
   * {@link assertSignalStackClientIdentity}). Must match apps/api's value.
   * Optional: the check no-ops when unset.
   */
  SIGNALSTACK_ORG_SLUG: z.string().optional(),
  /**
   * Keycloak base URL for the bearer token grant. The worker has no OIDC
   * login of its own (no acting-org header, no user session) — these two
   * vars exist solely to mint the service token.
   */
  KEYCLOAK_URL: z.string().optional(),
  KEYCLOAK_REALM: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Fails hard (per designs/_DECISIONS.md D7) when TLS certificate verification
 * is disabled under a production environment; warns loudly in dev/staging so
 * the relaxation is never silent. This is the enforcement that makes the
 * insecure posture impossible in prod — the compose default flip alone is not
 * enough, because an operator can still export the var globally.
 *
 * Uses `process.emitWarning` (not the app logger) for the non-fatal path to
 * avoid a config↔logger circular import (logger.ts imports this module).
 *
 * @param c - Parsed runtime config.
 * @throws {ConfigError} When NODE_TLS_REJECT_UNAUTHORIZED=0 in production.
 */
export function assertTlsPosture(c: Config): void {
  // Node disables verification only for the exact string '0'.
  if (c.NODE_TLS_REJECT_UNAUTHORIZED !== '0') return;
  const env = c.INSTANCE_ENV ?? c.NODE_ENV;
  const msg = 'NODE_TLS_REJECT_UNAUTHORIZED=0 disables all TLS certificate verification';
  if (env === 'production') {
    throw new ConfigError(`${msg}; refusing to start in production.`, {
      code: 'INSECURE_TLS_IN_PROD',
    });
  }
  process.emitWarning(
    `${msg}. Allowed outside production (env=${env}); never use this on a VM/prod deploy.`,
    { code: 'INSECURE_TLS_POSTURE' },
  );
}

/**
 * Fails hard at boot when the bearer service-auth credential cannot resolve to
 * the right Signals organisation.
 *
 * Signals maps the calling client id → `organization.slug` to decide *which*
 * org a service call acts as, so `SIGNALSTACK_CLIENT_ID` must equal this
 * aggregator's slug there. A mismatch authenticates fine and then acts as the
 * wrong (or no) org — far harder to diagnose than a refused boot. The expected
 * slug is deployment-specific, so it is configuration
 * (`SIGNALSTACK_ORG_SLUG`), not a constant; the check no-ops when unset.
 *
 * Scope note: a *missing* client id is deliberately NOT fatal here — the
 * signalstack factory already treats incomplete bearer config as "push
 * disabled" (a warn, not a crash), and this guard must not turn that into a
 * boot failure. It only rejects a client id that is present and *wrong*.
 *
 * @param c - Parsed runtime config.
 * @throws {ConfigError} When bearer mode is on and client id ≠ expected slug.
 */
export function assertSignalStackClientIdentity(c: Config): void {
  if (c.SIGNALSTACK_AUTH_MODE !== 'bearer') return;
  if (!c.SIGNALSTACK_CLIENT_ID) return;
  const expected = c.SIGNALSTACK_ORG_SLUG;
  if (expected && c.SIGNALSTACK_CLIENT_ID !== expected) {
    throw new ConfigError(
      `SIGNALSTACK_CLIENT_ID (${c.SIGNALSTACK_CLIENT_ID}) must equal SIGNALSTACK_ORG_SLUG ` +
        `(${expected}) — signals resolves the acting organisation from the client id, so a ` +
        'mismatch would act as the wrong org.',
      { code: 'SIGNALSTACK_CLIENT_ID_MISMATCH' },
    );
  }
}

export const config: Config = ConfigSchema.parse(process.env);
assertTlsPosture(config);
assertSignalStackClientIdentity(config);
