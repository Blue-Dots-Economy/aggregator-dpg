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
   * Comma-separated allow-list of the onboarding capabilities this deployment
   * offers when an aggregator **creates** a registration link (#637). Accepted
   * values today are the network's declared `registration_modes` keys — `form`
   * and `voice`; `bulk` is reserved for a future bulk-upload gate and does
   * nothing yet.
   *
   * **Absent from the environment ⇒ every capability is enabled**, which is
   * exactly today's behaviour, so an existing deployment that never sets this
   * is unaffected. `form,voice` is therefore identical to leaving it unset,
   * and `form` alone stops voice links being offered or created.
   *
   * A var that is *present but blank* is a misconfiguration, not a default:
   * it names no capability, so it disables everything and says so loudly. That
   * is why this is `.optional()` rather than `.default('')` — collapsing the
   * two would make the dangerous case indistinguishable from the safe one.
   * Anything shipping this key (compose, Helm ConfigMap) must omit it entirely
   * when unconfigured rather than render an empty string.
   *
   * Deliberately an env var rather than a key in `aggregator.config.yaml`:
   * every deployment pulls that YAML from the same repo branch, so dropping
   * `voice` there would disable voice in *every* environment including
   * production. This var is per-instance.
   *
   * Gates **creation only**. An already-issued link keeps resolving in its own
   * mode — a printed voice QR must not stop working — which is why
   * `routes/public-registration-links.ts` reads the unfiltered network config.
   */
  AGGREGATOR_ONBOARDING_ENABLED: z.string().optional(),
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
   * may use the same slug. Also the value the QR encodes (client-side).
   * Example: https://aggregator.example.com
   */
  PUBLIC_LINK_BASE_URL: z.string().default('http://localhost:3000'),
  // ─── Campaign export channel (#579) ─────────────────────────────────────
  // Per-channel by design: voice (#577) and email (#578) add their own
  // CAMPAIGN_VOICE_* / CAMPAIGN_EMAIL_* knobs rather than sharing these.
  /** Max `item_ids` accepted per export request body (after de-dup). */
  CAMPAIGN_EXPORT_MAX_ITEMS: z.coerce.number().int().positive().default(500),
  /** Ingress rate-limit window (seconds) for export submits, per org. */
  CAMPAIGN_EXPORT_SUBMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /** Max export submits allowed per window, per org. */
  CAMPAIGN_EXPORT_SUBMIT_MAX: z.coerce.number().int().positive().default(10),
  /** Max active (queued|processing) export jobs allowed per org at once. */
  CAMPAIGN_EXPORT_MAX_ACTIVE_PER_ORG: z.coerce.number().int().positive().default(3),
  /** Max `item_ids` (recipients) accepted per `POST /v1/campaign/email` request body. */
  EMAIL_MAX_RECIPIENTS: z.coerce.number().int().positive().default(200),
  /** BullMQ attempts for a campaign-process job (retry count on transient failure). */
  CAMPAIGN_EXPORT_ATTEMPTS: z.coerce.number().int().positive().default(3),

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
 * `azp` client ids allowed to reach the campaign-manager routes (PII export
 * #579, and the email/voice APIs that follow — all called by the same
 * `campaign-manager` client). This OVERRIDES the global `KEYCLOAK_ALLOWED_AZP`
 * on those routes, so they accept ONLY these clients — and the global list
 * excludes them, which blocks a campaign-manager token on every other endpoint
 * (default-deny both ways).
 *
 * @returns The allow-listed `azp` values (comma-separated env;
 *   default `['campaign-manager']`).
 */
export function campaignManagerAllowedAzp(): string[] {
  const raw = process.env.CAMPAIGN_MANAGER_ALLOWED_AZP?.trim() || 'campaign-manager';
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Never return an empty list: an empty allow-list disables the azp gate
  // entirely (assertAllowedAzp treats `[]` as "off"), which would open the most
  // sensitive route to any client. A pathological value (e.g. `","`) parses to
  // empty — fall back to the default rather than silently un-gating.
  return parsed.length > 0 ? parsed : ['campaign-manager'];
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

/**
 * Result of parsing the `AGGREGATOR_ONBOARDING_ENABLED` env value.
 *
 * As with {@link ParsedSignalsUiUrls}, warnings are returned rather than
 * logged: this module cannot import the pino logger (`logger.ts` imports
 * `config.ts`, so the reverse import would be circular). `app.ts` emits them
 * once a Fastify instance exists.
 */
export interface ParsedOnboardingEnabled {
  /**
   * The allow-listed capability keys, or `null` when the var is **absent from
   * the environment entirely**. `null` means "no restriction — every
   * capability is enabled" and is deliberately a different value from `[]`,
   * which means "explicitly nothing is enabled" (what a value that is present
   * but names no capability parses to — blank, whitespace-only, empty quotes,
   * or only separators). Collapsing the two would make an unset var
   * indistinguishable from one that disables everything.
   */
  capabilities: string[] | null;
  warnings: string[];
}

/**
 * Capability keys the allow-list accepts but which gate nothing yet.
 *
 * Forward-compatibility: a ConfigMap may ship `bulk` ahead of the code that
 * implements bulk gating, and that must neither break boot nor be reported as
 * a typo. Reserved keys are excluded from {@link unknownOnboardingCapabilities}
 * so they get their own, accurate diagnostic — but they are **not** excluded
 * from the allow-list itself, so listing only reserved keys still disables all
 * onboarding (fail-closed; see {@link parseOnboardingEnabled}).
 */
export const RESERVED_ONBOARDING_CAPABILITIES: ReadonlySet<string> = new Set(['bulk']);

/**
 * Parse the `AGGREGATOR_ONBOARDING_ENABLED` allow-list.
 *
 * Exported so it can be unit-tested without mutating `process.env`. Trims and
 * lowercases each entry, accepts commas and any whitespace (including
 * newlines) as separators, drops empties, de-duplicates, and tolerates a layer
 * of Helm `| quote` wrapping.
 *
 * Only a genuinely **absent** var enables everything. A var that is present
 * but blank — `""`, `"   "`, a Helm `| quote` over an empty string, a block
 * scalar whose `{{- if }}` rendered nothing — is a misconfiguration, and the
 * one shape most likely to occur in a real deployment. Treating it as "unset"
 * would silently re-enable the very modes the operator set out to withhold,
 * with nothing in the logs to explain it, so it takes the same loud lockout
 * path as `","`.
 *
 * Values are **not** validated against the network's declared registration
 * modes here — those resolve asynchronously, long after this runs, exactly as
 * with `parseSignalsUiUrls`. `frm` parses perfectly clean at this stage; the
 * cross-check happens once the network config resolves (see
 * {@link unknownOnboardingCapabilities}).
 *
 * @param raw - The raw env value (or `undefined` when the var is not set).
 * @returns The parsed capability list (`null` ⇒ all enabled) plus a warning
 *   per duplicate entry, and one more when the var is set yet names nothing.
 */
export function parseOnboardingEnabled(raw: string | undefined): ParsedOnboardingEnabled {
  // Genuinely unset — the only path to "everything enabled".
  if (raw === undefined) return { capabilities: null, warnings: [] };
  const v = stripHelmQuoting(raw);
  const capabilities: string[] = [];
  const warnings: string[] = [];
  // Whitespace counts as a separator alongside `,`: `form voice` is an obvious
  // operator intent, and splitting on commas alone would turn it into the
  // single bogus capability `"form voice"` that matches nothing and hard-locks
  // link creation without so much as a parse warning.
  for (const entry of v.split(/[\s,]+/)) {
    const key = entry.trim().toLowerCase();
    if (!key) continue;
    if (capabilities.includes(key)) {
      warnings.push(
        `AGGREGATOR_ONBOARDING_ENABLED: duplicate entry "${key}" — listing it once is enough`,
      );
      continue;
    }
    capabilities.push(key);
  }
  if (capabilities.length === 0) {
    // Set, but names nothing: blank/whitespace-only (`""`, `"   "`, `"''"`) or
    // separators only (`",,"`). Treated as "nothing enabled" rather than
    // "unset" — see the fail-closed rationale above.
    warnings.push(
      v === ''
        ? 'AGGREGATOR_ONBOARDING_ENABLED is set but blank — it names no capability, so no registration mode will be offered. Remove the variable entirely (not just its value) to enable all of them.'
        : 'AGGREGATOR_ONBOARDING_ENABLED is set but names no capability — no registration mode will be offered. Unset the variable to enable all of them.',
    );
  }
  return { capabilities, warnings };
}

/**
 * The onboarding capabilities this deployment offers, or `null` for "all".
 *
 * Read from the live environment at **call time** rather than from the frozen
 * `config` snapshot — same rationale as {@link supportEmail}: it is consumed
 * per request (the config endpoint and the create-link handler both need the
 * current value) and tests must be able to vary it across cases inside one
 * Vitest worker, where `config` reflects whatever env existed at first import.
 *
 * @returns The allow-listed capability keys, or `null` when unset/blank.
 */
export function onboardingEnabledCapabilities(): readonly string[] | null {
  return parseOnboardingEnabled(process.env.AGGREGATOR_ONBOARDING_ENABLED).capabilities;
}

/**
 * Whether one onboarding capability is enabled for this deployment.
 *
 * The single predicate behind both enforcement points: the
 * `registration_modes` map served by `GET /v1/aggregator-config` (which is
 * what removes the option from the admin dropdown) and the create-link
 * validation (which stops the gate being bypassed by calling the API direct).
 *
 * @param capability - A capability / registration-mode key, e.g. `voice`.
 * @returns `true` when the allow-list is unset (everything enabled) or when it
 *   contains the key.
 */
export function isOnboardingCapabilityEnabled(capability: string): boolean {
  const enabled = onboardingEnabledCapabilities();
  return enabled === null || enabled.includes(capability);
}

/**
 * The declared registration modes this deployment actually offers.
 *
 * The single derivation of "enabled", shared by all three consumers: the boot
 * cross-check diagnostics, the `registration_modes` map served by
 * `GET /v1/aggregator-config`, and create-link validation. Deriving it
 * independently anywhere would let the diagnostics disagree with enforcement
 * the moment the predicate grows a rule (a wildcard, a reserved key) — an
 * ERROR claiming nothing is enabled where creation works, or silence where
 * every call 400s.
 *
 * @param declared - The network's declared `registration_modes` keys.
 * @returns The subset the allow-list permits, in declared order; the whole
 *   list unchanged when the allow-list is unset.
 */
export function enabledRegistrationModes(declared: readonly string[]): string[] {
  return declared.filter((mode) => isOnboardingCapabilityEnabled(mode));
}

/**
 * Which allow-listed capabilities are reserved keys that gate nothing yet.
 *
 * Split out from {@link unknownOnboardingCapabilities} so a forward-compatible
 * value gets an accurate diagnostic. `bulk` is documented as an accepted
 * value, so reporting it as "matches no registration mode declared by this
 * network" reads as a bug report about a value the docs endorsed.
 *
 * @param capabilities - The parsed allow-list (`null` ⇒ all enabled).
 * @returns The reserved values in listed order; always empty when the
 *   allow-list is unset, since it restricts nothing.
 */
export function reservedOnboardingCapabilities(capabilities: readonly string[] | null): string[] {
  if (capabilities === null) return [];
  return capabilities.filter((capability) => RESERVED_ONBOARDING_CAPABILITIES.has(capability));
}

/**
 * Which allow-listed capabilities name no registration mode this network
 * declares.
 *
 * {@link parseOnboardingEnabled} cannot do this — it runs at module load,
 * whereas the declared modes come from the resolved network config. So a typo
 * (`frm` for `form`) parses clean and then withholds every mode with nothing
 * said, which is a worse failure than a malformed value because the dropdown
 * just quietly empties. Mirrors {@link unknownSignalsUiUrlDomains}.
 *
 * Pure and log-only: the caller warns and the allow-list is used unchanged.
 * Reserved keys are excluded — they are reported separately by
 * {@link reservedOnboardingCapabilities}, because "unrecognised" would be the
 * wrong thing to say about a value this repo documents as accepted.
 *
 * @param capabilities - The parsed allow-list (`null` ⇒ all enabled).
 * @param declaredModes - The network's declared `registration_modes` keys.
 * @returns The unrecognised values in listed order; empty when all match (and
 *   always empty when the allow-list is unset, since it restricts nothing).
 */
export function unknownOnboardingCapabilities(
  capabilities: readonly string[] | null,
  declaredModes: readonly string[],
): string[] {
  if (capabilities === null) return [];
  const declared = new Set(declaredModes);
  return capabilities.filter(
    (capability) => !declared.has(capability) && !RESERVED_ONBOARDING_CAPABILITIES.has(capability),
  );
}

/**
 * Warnings from parsing `AGGREGATOR_ONBOARDING_ENABLED`, emitted once by
 * `app.ts` via `app.log.warn` (this module can't log — see
 * {@link ParsedOnboardingEnabled}).
 */
export const onboardingEnabledWarnings: string[] = parseOnboardingEnabled(
  config.AGGREGATOR_ONBOARDING_ENABLED,
).warnings;
