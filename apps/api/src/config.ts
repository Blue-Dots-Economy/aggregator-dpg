/**
 * Runtime configuration loaded from environment variables.
 *
 * All values are read once at module init so request handlers stay pure.
 * Defaults target the local-dev compose stack; production overrides come
 * from `.env` or the orchestration layer.
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
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Comma-separated list of allowed CORS origins for the BFF and any future
   * direct browser clients. Use `*` only in dev.
   */
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3100'),
  /**
   * Postgres connection string. Deliberately has **no default** — the URL
   * carries credentials, so embedding one in source would ship a usable
   * secret and mask a misconfigured deploy behind a silent fallback to
   * localhost. Startup fails when it is unset.
   */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL must be set'),
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
  /**
   * Enables the parent-org → coordinator hierarchy for this instance
   * (spec §2). OFF (default) = today's flat registration/approval flow,
   * unchanged: no org tab, no org dropdown, no `aggregator_orgs` rows,
   * `aggregators.parent_org_id` stays null. Read once at startup; flipping
   * requires a restart. Two instances of the same network can differ.
   */
  ORG_HIERARCHY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Public origin of the API service; used to assemble admin email links.
   * Also advertised as `servers[0].url` in the OpenAPI spec (served and
   * dumped) — deployments must override this so the docs surface points
   * callers at the right host.
   */
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  /** Public origin of the portal (BFF web app); used in welcome emails. */
  PUBLIC_PORTAL_URL: z.string().default('http://localhost:3000'),
  /** Comma-separated list of admin recipient email addresses. */
  ADMIN_EMAILS: z.string().default(''),
  /**
   * Per-domain Signals UI login URLs, as comma-separated `domain=url` pairs:
   *
   *   SIGNALS_UI_URLS=seeker=https://signals-seeker.example/auth/login,provider=https://...
   *
   * Each network domain (from network.json) is fronted by its own Signals UI
   * deployment, so this is a map rather than a single origin. Unset ⇒ the
   * public registration form shows no Signals hand-off at all.
   *
   * The value MUST be a Signals **UI** URL (normally `<origin>/auth/login`),
   * never a Keycloak authorization URL: Keycloak URLs embed one-time `state`
   * and `code_challenge` values bound to the browser that generated them, so a
   * hardcoded one fails PKCE/state validation for every user. `/auth/login` is
   * the page that mints a valid Keycloak URL per attempt.
   */
  SIGNALS_UI_URLS: z.string().default(''),
  /**
   * Recipient(s) for contact-support submissions (#120-equivalent).
   * Feature-gated: unset ⇒ endpoint 503, web button hidden. Accepts multiple
   * comma-separated addresses (all receive the TO copy).
   */
  SUPPORT_EMAIL: z.string().optional(),
  /**
   * Optional CC recipient(s) for contact-support submissions. Accepts
   * multiple comma-separated addresses. Unset ⇒ no CC header is added.
   */
  SUPPORT_CC_EMAIL: z.string().optional(),
  /**
   * Attachment budget for the contact-support form (#551): total decoded bytes
   * across all attachments on one submission, and how many files it may carry.
   * Served to the web form by `GET /v1/support/config`, so raising them needs no
   * web rebuild. SES rejects a message over 10MB after base64 inflation, so
   * ~7MB of original file is the practical ceiling whatever these say.
   */
  SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  SUPPORT_ATTACHMENT_MAX_FILES: z.coerce.number().int().positive().default(3),

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

  // ─── Approval links ───────────────────────────────────────────────────────
  /**
   * Lifetime of the admin approval/rejection links emailed on a new
   * aggregator registration (seconds). Drives BOTH the signed-token expiry
   * and the human-readable "expires in …" wording on the admin email and the
   * confirmation page, so the two can never drift. Default: 7 days.
   */
  APPROVAL_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60),

  /**
   * Extra grace beyond the approval-token TTL before a still-pending
   * registration is eligible for cleanup. Default 24h.
   */
  REGISTRATION_PENDING_GRACE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),

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
  // Base + Keycloak-bearer credential fields are shared with the worker via
  // @aggregator-dpg/shared-primitives/config; acting-org-id is api-only.
  ...signalStackConfigFields,
  /**
   * Platform-wide signalstack organisation id under which admin aggregator
   * upserts are performed (sent as `x-acting-org-id`). Required when
   * SIGNALSTACK_BASE_URL is set so the aggregator-approval flow can register
   * each newly-approved aggregator as a signalstack org.
   */
  SIGNALSTACK_ACTING_ORG_ID: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse(process.env);
assertTlsPosture(config);
assertSignalStackClientIdentity(config);

export const corsOrigins: string[] = config.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Whether the org→coordinator hierarchy is enabled for this instance.
 *
 * Read from the live environment at **call time** rather than from the frozen
 * `config` snapshot. It is consumed only on the startup path (route
 * registration inside `buildApp()`), so this still honours "read once at
 * startup" (configuration-discipline) while remaining deterministic under
 * Vitest's hoisted-import evaluation order, where a test sets the env var
 * before `buildApp()` runs but after `config` was first parsed.
 *
 * @returns `true` when `ORG_HIERARCHY_ENABLED` is the literal string `"true"`.
 */
export function orgHierarchyEnabled(): boolean {
  return process.env.ORG_HIERARCHY_ENABLED === 'true';
}

/**
 * Recipient address for contact-support submissions.
 *
 * Read from the live environment at **call time** rather than from the
 * frozen `config` snapshot — mirrors {@link orgHierarchyEnabled}. Unlike
 * that flag, this one is consumed on every request (`GET /v1/support/config`
 * and `POST /v1/support` both need the current value, not just a
 * startup-time snapshot), and it must be independently toggleable across
 * test cases (configured vs unset) within the same Vitest worker, where the
 * frozen `config.SUPPORT_EMAIL` reflects whatever env was present the first
 * time `config.ts` was imported and cannot be changed afterwards.
 *
 * @returns The configured support recipient(s) as a clean comma-joined list,
 *   or `undefined` when `SUPPORT_EMAIL` is unset/empty (⇒ the support form
 *   reports disabled and `POST /v1/support` returns 503
 *   `SUPPORT_NOT_CONFIGURED`). Multiple comma-separated addresses are
 *   trimmed, de-blanked, and rejoined with `, `.
 */
export function supportEmail(): string | undefined {
  return normaliseEmailList(process.env.SUPPORT_EMAIL);
}

/**
 * CC recipient(s) for contact-support submissions.
 *
 * Read from the live environment at **call time** — mirrors
 * {@link supportEmail}'s rationale: consumed on every `POST /v1/support`
 * request (not a startup-only snapshot) and must be independently toggleable
 * across test cases within the same Vitest worker, where the frozen `config`
 * snapshot cannot be changed after first import.
 *
 * @returns The configured CC list as a clean comma-joined string, or
 *   `undefined` when `SUPPORT_CC_EMAIL` is unset/empty. Multiple
 *   comma-separated addresses are trimmed, de-blanked, and rejoined with `, `.
 */
export function supportCc(): string | undefined {
  return normaliseEmailList(process.env.SUPPORT_CC_EMAIL);
}

/**
 * Public portal origin surfaced in the support email as the "raised from"
 * link, so support staff can tell which instance a submission came from.
 * Sourced from the deploy-time {@link config.PUBLIC_PORTAL_URL}.
 *
 * @returns The configured portal URL.
 */
export function supportPortalLink(): string {
  return config.PUBLIC_PORTAL_URL;
}

/**
 * Attachment limits for the contact-support form (#551).
 *
 * Read from the live environment at **call time**, mirroring
 * {@link supportEmail}'s rationale: both the config endpoint and the submit
 * handler need the current value, and tests must be able to vary the limits
 * across cases within one Vitest worker, where the frozen `config` snapshot
 * cannot change after first import.
 *
 * @returns The configured maximum total decoded bytes and file count, falling
 *   back to 5MB / 3 files when unset or not a positive integer.
 */
export function supportAttachmentLimits(): { maxTotalBytes: number; maxFiles: number } {
  const parsed = z
    .object({
      SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES: z.coerce
        .number()
        .int()
        .positive()
        .catch(5 * 1024 * 1024)
        .default(5 * 1024 * 1024),
      SUPPORT_ATTACHMENT_MAX_FILES: z.coerce.number().int().positive().catch(3).default(3),
    })
    .parse({
      SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES: process.env.SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES,
      SUPPORT_ATTACHMENT_MAX_FILES: process.env.SUPPORT_ATTACHMENT_MAX_FILES,
    });
  return {
    maxTotalBytes: parsed.SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES,
    maxFiles: parsed.SUPPORT_ATTACHMENT_MAX_FILES,
  };
}

/**
 * Normalises a comma-separated email env value into a clean, comma-joined
 * list: splits on commas, trims each entry, drops empties, rejoins with `, `.
 *
 * @param raw - The raw env value (or `undefined`).
 * @returns The joined list, or `undefined` when nothing usable remains — so
 *   "unset" and "blank/whitespace-only" are treated identically.
 */
function normaliseEmailList(raw: string | undefined): string | undefined {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list.join(', ') : undefined;
}

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
  return stripHelmQuoting(raw ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const adminEmails: string[] = parseEnvEmailList(config.ADMIN_EMAILS);

/**
 * Result of parsing the `SIGNALS_UI_URLS` env value: the successfully parsed
 * `{ domain: url }` map plus a warning string per skipped/malformed entry.
 *
 * The warnings are returned rather than logged directly because this module
 * cannot import the pino logger (`logger.ts` imports `config.ts`, so the
 * reverse import would be circular) — the caller (`app.ts`) logs them once a
 * Fastify instance exists.
 */
export interface ParsedSignalsUiUrls {
  urls: Record<string, string>;
  warnings: string[];
}

/**
 * Strips a single layer of Helm `| quote`-style wrapping (single or double
 * quotes) plus surrounding whitespace from a raw env value.
 *
 * @param raw - The raw string that may be quote-wrapped by Helm templating.
 * @returns The unwrapped, trimmed string.
 */
function stripHelmQuoting(raw: string): string {
  const v = raw.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1).trim();
  }
  return v;
}

/** The outcome of parsing one `domain=url` entry from `SIGNALS_UI_URLS`. */
type SignalsUiUrlEntryResult =
  { ok: true; domain: string; url: string } | { ok: false; warning: string };

/**
 * Parses and validates a single `domain=url` entry from `SIGNALS_UI_URLS`.
 *
 * @param pair - One trimmed, non-empty `domain=url` entry.
 * @returns The parsed `{ domain, url }` pair, or a warning naming the
 *   offending key if the entry is malformed.
 */
function parseSignalsUiUrlEntry(pair: string): SignalsUiUrlEntryResult {
  // First `=` only — URLs carry `=` inside query strings.
  const eq = pair.indexOf('=');
  if (eq === -1) {
    // Called out separately from the invalid-key case below: a bare word is
    // almost always a comma that should have been an `=` (or vice versa), and
    // saying "no `=` separator" points straight at it.
    return {
      ok: false,
      warning: `SIGNALS_UI_URLS: skipping entry with no "=" separator: "${pair}"`,
    };
  }
  const domain = pair.slice(0, eq).trim();
  const url = pair.slice(eq + 1).trim();
  if (!/^[a-z][a-z0-9_]*$/.test(domain)) {
    return {
      ok: false,
      warning: `SIGNALS_UI_URLS: skipping entry with invalid domain key: "${pair}"`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      warning: `SIGNALS_UI_URLS: skipping domain "${domain}" — value is not a valid URL`,
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      warning: `SIGNALS_UI_URLS: skipping domain "${domain}" — only http(s) URLs are allowed`,
    };
  }
  return { ok: true, domain, url };
}

/**
 * Parse the `SIGNALS_UI_URLS` env value into a `{ domain: url }` map.
 *
 * Exported (unlike `parseEnvEmailList`) so it can be unit-tested without
 * mutating `process.env`, which `config` snapshots at module load.
 *
 * A malformed entry is dropped with a warning rather than crashing boot: the
 * Signals hand-off is optional, and one typo must not take the API down. The
 * warning keeps it from being a silent failure.
 *
 * On a **duplicate domain key** the last entry wins — the map is built by
 * assignment, so a later `seeker=…` overwrites an earlier one. That is a
 * warning too, because a repeated key means one of the two URLs the operator
 * wrote is being thrown away.
 *
 * Domain keys are validated for *format* only, never against the network's
 * declared domains — those resolve asynchronously, long after this runs at
 * module load. `seeker` and `seekr` are equally well-formed here. The
 * cross-check against the real domain list happens once the network config
 * resolves; see `unknownSignalsUiUrlDomains`.
 */
export function parseSignalsUiUrls(raw: string | undefined): ParsedSignalsUiUrls {
  const v = stripHelmQuoting(raw ?? '');
  const urls: Record<string, string> = {};
  const warnings: string[] = [];
  for (const entry of v.split(/[,\n]/)) {
    const pair = entry.trim();
    if (!pair) continue;
    const result = parseSignalsUiUrlEntry(pair);
    if (!result.ok) {
      warnings.push(result.warning);
      continue;
    }
    if (Object.hasOwn(urls, result.domain)) {
      warnings.push(
        `SIGNALS_UI_URLS: duplicate entry for domain "${result.domain}" — the last one wins`,
      );
    }
    urls[result.domain] = result.url;
  }
  return { urls, warnings };
}

/**
 * Which parsed `SIGNALS_UI_URLS` keys name no domain this network declares.
 *
 * `parseSignalsUiUrls` cannot do this: it runs at module load, whereas the
 * domain list comes from the resolved network config (a file read plus a
 * signalstack `network.json` fetch). So a typo'd key — `seekr=…` — parses
 * perfectly clean and then silently disables the hand-off for `seeker`, which
 * is a worse failure than a malformed URL because nothing warns.
 *
 * Pure and log-only by design: the caller warns, and the parsed map is used
 * unchanged. Filtering unknown keys would be wrong — a domain added to
 * network.json ahead of the ConfigMap rollout (or vice versa) must not be able
 * to turn a working hand-off off, and the api must never fail boot over an
 * optional feature's env var.
 *
 * @param urls - The parsed `{ domain: url }` map.
 * @param knownDomains - `ResolvedNetworkConfig.domainIds`.
 * @returns The unrecognised keys, in insertion order; empty when all match.
 */
export function unknownSignalsUiUrlDomains(
  urls: Readonly<Record<string, string>>,
  knownDomains: readonly string[],
): string[] {
  const known = new Set(knownDomains);
  return Object.keys(urls).filter((domain) => !known.has(domain));
}

const parsedSignalsUiUrls = parseSignalsUiUrls(config.SIGNALS_UI_URLS);

/**
 * Per-domain Signals UI login URLs, parsed once at boot.
 * Empty when unset — the public form then renders no Signals hand-off.
 *
 * Frozen, and typed `Readonly`, because every value in here has been checked to
 * be an absolute http(s) URL. That invariant is what lets the web app drop the
 * value straight into an `href`; a mutable module-level export would let any
 * importer quietly add an unvalidated entry and break it from the inside.
 */
export const signalsUiUrls: Readonly<Record<string, string>> = Object.freeze(
  parsedSignalsUiUrls.urls,
);

/**
 * Warnings from parsing `SIGNALS_UI_URLS`, one per skipped/malformed entry.
 * Logged once by `app.ts` via `app.log.warn` so a misconfigured env is
 * visible in cluster logs (this module can't log directly — see
 * `ParsedSignalsUiUrls`).
 */
export const signalsUiUrlWarnings: string[] = parsedSignalsUiUrls.warnings;
