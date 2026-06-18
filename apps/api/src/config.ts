/**
 * Runtime configuration loaded from environment variables.
 *
 * All values are read once at module init so request handlers stay pure.
 * Defaults target the local-dev compose stack; production overrides come
 * from `.env` or the orchestration layer.
 */

import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Comma-separated list of allowed CORS origins for the BFF and any future
   * direct browser clients. Use `*` only in dev.
   */
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3100'),
  /** Postgres connection string. Default points at the compose Postgres
   *  exposed on host port 5433 (5432 is left to system Postgres). */
  DATABASE_URL: z
    .string()
    .default('postgres://aggregator:aggregator-dev@localhost:5433/aggregator'),
  /** Run pending DB migrations on startup. Disable in CI/test to avoid races. */
  RUN_MIGRATIONS_ON_BOOT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Serve the OpenAPI spec + Scalar reference UI at /api/reference. The API
   * is internet-reachable, so the docs surface (including admin route paths)
   * is enumerable when enabled — defaults ON for dev convenience. This flag
   * is force-disabled under NODE_ENV=production (see {@link apiReferenceEnabled})
   * so a prod deploy never serves an enumerable route map by accident; opt back
   * in for prod only via API_REFERENCE_FORCE.
   */
  API_REFERENCE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Escape hatch to serve the docs surface even under NODE_ENV=production.
   * Off by default — must be explicitly set to expose the reference in prod.
   */
  API_REFERENCE_FORCE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Public origin of the API service; used to assemble admin email links. */
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  /** Public origin of the portal (BFF web app); used in welcome emails. */
  PUBLIC_PORTAL_URL: z.string().default('http://localhost:3000'),
  /** Comma-separated list of admin recipient email addresses. */
  ADMIN_EMAILS: z.string().default(''),

  // ─── Object storage (bulk uploads + errors.csv) ──────────────────────────
  /**
   * S3-compatible endpoint URL. For MinIO in dev, set to
   * `http://minio:9000` (in-container) or `http://localhost:9000` (host).
   * For real S3, leave blank — the SDK uses AWS endpoints by region.
   */
  S3_ENDPOINT: z.string().optional(),
  /**
   * Browser-reachable endpoint used to mint pre-signed URLs. Falls back to
   * S3_ENDPOINT when unset (single-host dev). In production this is the
   * public hostname (e.g. https://s3.amazonaws.com or
   * https://files.example.com) while S3_ENDPOINT remains the in-cluster /
   * VPC-internal hostname for HEAD/PUT/GET ops.
   */
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  /** Bucket holding uploaded CSVs and generated error reports. */
  S3_BUCKET: z.string().default('aggregator-bulk-uploads'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /**
   * Force path-style addressing (bucket.endpoint.com vs endpoint.com/bucket).
   * Required for MinIO; auto-detected for AWS.
   */
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Redis connection URL used by BullMQ queues. */
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** Pre-signed PUT URL TTL for bulk uploads (seconds). */
  BULK_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /** Maximum CSV file size for the pre-signed PUT (bytes). */
  BULK_UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),

  // ─── Registration links ─────────────────────────────────────────────────
  /**
   * Base URL of the public landing page that resolves a registration link.
   * The public URL is `${PUBLIC_LINK_BASE_URL}/${org_slug}/${slug}`; the
   * aggregator's org_slug namespaces the per-link slug so two aggregators
   * may use the same slug. Encoded into the QR PNG.
   * Example: https://aggregator.example.com
   */
  PUBLIC_LINK_BASE_URL: z.string().default('http://localhost:3000'),
  /** Pre-signed GET URL TTL for QR PNG downloads (seconds). */
  QR_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  // ─── Schema loader ──────────────────────────────────────────────────────
  /** Absolute or relative path to `config/schemas/`. Used by link-submit Ajv. */
  SCHEMA_ROOT_DIR: z.string().default('./config/schemas'),

  // ─── Rate limit (public link submit) ────────────────────────────────────
  PUBLIC_SUBMIT_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW: z.coerce.number().int().positive().default(20),

  /**
   * Trust-proxy configuration for Fastify. Controls which upstream addresses
   * are allowed to supply `X-Forwarded-For` (and therefore decide what
   * `req.ip` evaluates to — used by the public rate limiter).
   *
   * Accepts a comma-separated list of IPs, CIDR ranges, or Fastify named
   * groups (`loopback`, `linklocal`, `uniquelocal`). Production deployments
   * MUST set this to the BFF subnet so callers cannot spoof their source IP.
   * The default `loopback,linklocal,uniquelocal` trusts only RFC1918 private
   * ranges, which is safe behind a single-host Docker compose dev stack.
   */
  TRUST_PROXY: z.string().default('loopback,linklocal,uniquelocal'),

  // ─── SignalStack outward push ───────────────────────────────────────────
  /** Base URL of the signalstack API. When unset, signalstack push is disabled. */
  SIGNALSTACK_BASE_URL: z.string().url().optional(),
  /** Admin api-key for signalstack onboard. Required when SIGNALSTACK_BASE_URL is set. */
  SIGNALSTACK_ADMIN_KEY: z.string().optional(),
  /**
   * Platform-wide signalstack organisation id under which admin aggregator
   * upserts are performed (sent as `x-acting-org-id`). Required when
   * SIGNALSTACK_BASE_URL is set so the aggregator-approval flow can register
   * each newly-approved aggregator as a signalstack org.
   */
  SIGNALSTACK_ACTING_ORG_ID: z.string().optional(),
  /** item_network sent on every onboard call. */
  SIGNALSTACK_ITEM_NETWORK: z.string().default('blue_dot'),
  /** Per-request timeout for signalstack onboard calls. */
  SIGNALSTACK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // ─── Registration FSM ───────────────────────────────────────────────────
  /**
   * T1 — hours after submission before an UNVERIFIED registration is
   * abandoned and its PII purged. Default 72 h.
   */
  REGISTRATION_UNVERIFIED_TTL_HOURS: z.coerce.number().int().positive().default(72),
  /**
   * T2 — hours after verification before a VERIFIED or APPROVED registration
   * that has not completed all provisioning steps is considered stuck and the
   * reconciler escalates. Default 168 h (7 days).
   */
  REGISTRATION_STUCK_TTL_HOURS: z.coerce.number().int().positive().default(168),
  /**
   * How long (minutes) a verification link / OTP remains valid before it
   * expires and the applicant must request a resend. Default 60 min.
   */
  REGISTRATION_VERIFICATION_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  /**
   * Minimum time (minutes) between resend attempts for verification or
   * admin-notification emails. Prevents resend spam. Default 60 min.
   */
  REGISTRATION_RESEND_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(60),
  /**
   * Maximum number of attempts per provision step before it is dead-lettered.
   * Once a step reaches this count it is marked `dead` and skipped by future
   * reconcile ticks until an admin resets it via `reconcile/by-contact?reset=true`.
   */
  REGISTRATION_MAX_PROVISION_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /**
   * Base delay (seconds) for exponential backoff between provision attempts.
   * Delay = base × 2^(attempts-1). Default 60 s → 60, 120, 240, 480, 960 s.
   */
  REGISTRATION_PROVISION_BACKOFF_BASE_SEC: z.coerce.number().int().positive().default(60),
  /**
   * TTL (hours) for the admin approval token minted in the approval notification
   * email. Overrides the legacy 1 h default to allow human review time.
   * Default 168 h (7 days).
   */
  REGISTRATION_APPROVAL_TTL_HOURS: z.coerce.number().int().positive().default(168),
  /**
   * Minimum time (minutes) between welcome or rejection email resend attempts.
   * Mirrors REGISTRATION_RESEND_COOLDOWN_MINUTES but scoped to post-approval
   * emails so they can be tuned independently. Default 60 min.
   */
  REGISTRATION_WELCOME_RESEND_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(60),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse(process.env);

export const corsOrigins: string[] = config.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Effective docs-surface switch used to gate the OpenAPI spec + Scalar UI.
 *
 * Secure-by-default on a public API: even when `API_REFERENCE_ENABLED` is on,
 * the enumerable route map is force-disabled under `NODE_ENV=production` unless
 * `API_REFERENCE_FORCE` is also set. Dev/staging keep it on for convenience.
 */
export const apiReferenceEnabled: boolean =
  config.API_REFERENCE_ENABLED && (config.NODE_ENV !== 'production' || config.API_REFERENCE_FORCE);

/**
 * Comma-separated ADMIN_EMAILS env value parsed into a clean list.
 * Resilient to wrapping quotes left in by Helm / ConfigMap `| quote`
 * filters, stray whitespace, and newline separators.
 */
function parseEnvEmailList(raw: string | undefined): string[] {
  let v = (raw ?? '').trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const adminEmails: string[] = parseEnvEmailList(config.ADMIN_EMAILS);
