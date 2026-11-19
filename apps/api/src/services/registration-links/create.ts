/**
 * Registration-link creation shared by `POST /v1/links/create` and operator tools.
 *
 * Checks the domain, registration mode and voice bot against the network
 * config, then stores the link, retrying on a slug collision. Belongs to
 * `@aggregator-dpg/api`.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';
import { stripTrailingSlashes } from '@aggregator-dpg/shared-primitives/url';
import { config, enabledRegistrationModes } from '../../config.js';
import { getNetworkConfig } from '../network-config.js';
import { getRegistrationLinksStore } from '../registration-links-store/index.js';
import type { RegistrationLink } from '../registration-links-store/index.js';
import { botsForDomain, modeOffersVoice, resolveDefaultVoiceBot } from '../voice-bots/index.js';

/** Attempts at a free slug before giving up with DUPLICATE_SLUG. */
export const SLUG_RETRIES = 5;

/** A caller-chosen link slug: lowercase, hyphen-separated, 3-60 chars. */
export const LinkSlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase + hyphens (a-z, 0-9)')
  .min(3)
  .max(60);

/** What a new registration link needs. */
export interface CreateLinkInput {
  /** The coordinator's `users.id`; the link belongs to it. */
  userId: string;
  /** The coordinator's org slug, used in the public URL. */
  orgSlug: string;
  /** The profile types (network domain ids) the coordinator serves. */
  servedDomains: readonly string[];
  domain: string;
  /** Registration mode key; omitted picks `form` when enabled, else the first enabled mode. */
  registrationMode?: string;
  /** Voice bot key; omitted takes the domain's default or only bot for a voice mode. */
  voiceBotKey?: string | null;
  /** Caller's slug; omitted gets a random one. A collision adds a random suffix. */
  slug?: string;
  context?: Record<string, unknown>;
  status: 'draft' | 'live';
  expiresAt?: Date | null;
  /** Who created the link, stored as `created_by`. */
  createdBy: string;
  log: FastifyBaseLogger;
}

/** Error codes of link creation; each is a key of the API error catalogue. */
export type CreateLinkErrorCode =
  | 'SCHEMA_VALIDATION'
  | 'DOMAIN_NOT_SERVED'
  | 'INVALID_REGISTRATION_MODE'
  | 'INVALID_VOICE_BOT'
  | 'VOICE_BOT_REQUIRED'
  | 'DUPLICATE_SLUG'
  | 'DB_UNAVAILABLE';

/** A refused or failed link creation. */
export interface CreateLinkError {
  code: CreateLinkErrorCode;
  /** Replaces the catalogue detail for this occurrence. */
  detail?: string;
  fields?: Record<string, unknown>;
  cause?: Error;
}

/** Result of link creation: the stored link and its public URL (`null` for a draft). */
export type CreateLinkResult =
  | { ok: true; value: { link: RegistrationLink; publicUrl: string | null } }
  | { ok: false; error: CreateLinkError };

/** Result of a step that may refuse. */
export type Step<T> = { ok: true; value: T } | { ok: false; error: CreateLinkError };

const fail = (error: CreateLinkError): { ok: false; error: CreateLinkError } => ({
  ok: false,
  error,
});

/**
 * Builds the public URL for a link: `${PUBLIC_LINK_BASE_URL}/<org_slug>/<slug>`.
 */
export function buildPublicUrl(orgSlug: string, slug: string): string {
  const base = stripTrailingSlashes(config.PUBLIC_LINK_BASE_URL);
  return `${base}/${orgSlug}/${slug}`;
}

/**
 * Generates the short hex suffix added to a slug on a collision.
 */
export function randomSuffix(bytes = 2): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Generates a random URL-safe slug (16 hex chars). The caller still retries on
 * a unique-violation.
 */
function generateSlug(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Resolves the registration mode, checked against the declared and enabled modes.
 *
 * `AGGREGATOR_ONBOARDING_ENABLED` is enforced here; hiding a mode in the UI is
 * not enough. With no mode given, `form` is used if enabled, else the first
 * enabled mode.
 *
 * @returns The mode key, or INVALID_REGISTRATION_MODE.
 */
export function resolveMode(
  requested: string | undefined,
  cfg: ResolvedNetworkConfig,
): Step<string> {
  const declaredModes = Object.keys(cfg.aggregator.registration_modes ?? {});
  const enabledModes = enabledRegistrationModes(declaredModes);
  const modeKey = requested ?? (enabledModes.includes('form') ? 'form' : enabledModes[0]) ?? 'form';
  if (!enabledModes.includes(modeKey)) {
    return fail({
      code: 'INVALID_REGISTRATION_MODE',
      detail: declaredModes.includes(modeKey)
        ? `registration_mode '${modeKey}' is not enabled for this deployment`
        : `registration_mode '${modeKey}' is not declared for this network`,
      fields: { declared: declaredModes, enabled: enabledModes },
    });
  }
  return { ok: true, value: modeKey };
}

/**
 * Validates the coordinator's voice-bot choice against the mode and domain.
 *
 * @returns The key to store: the chosen one, else the domain's default or only bot,
 *   or `null` only when no bot serves the domain; SCHEMA_VALIDATION when the mode
 *   does not offer voice and a key was sent; INVALID_VOICE_BOT when the key is
 *   unknown or serves another domain; VOICE_BOT_REQUIRED when several bots serve
 *   the domain and none is the default.
 */
export function checkVoiceBotChoice(
  requested: string | null | undefined,
  modeKey: string,
  domain: string,
  cfg: ResolvedNetworkConfig,
): Step<string | null> {
  if (!modeOffersVoice(modeKey, cfg)) {
    if (requested !== undefined && requested !== null) {
      return fail({
        code: 'SCHEMA_VALIDATION',
        detail: `voice_bot_key is not allowed for registration_mode '${modeKey}'`,
        fields: { voice_bot_key: 'not allowed for this mode' },
      });
    }
    return { ok: true, value: null };
  }
  const serving = botsForDomain(domain, cfg);
  if (requested !== undefined && requested !== null) {
    if (!serving.some((b) => b.key === requested)) {
      return fail({
        code: 'INVALID_VOICE_BOT',
        detail: `voice_bot_key '${requested}' does not serve domain '${domain}'`,
        fields: { configured: serving.map((b) => b.key) },
      });
    }
    return { ok: true, value: requested };
  }
  // Store the bot the link resolves to now, not `null`: a later second bot or a
  // changed default must not move or drop the voice option on a live link.
  const resolved = resolveDefaultVoiceBot(domain, cfg);
  if (serving.length > 1 && resolved === null) {
    return fail({
      code: 'VOICE_BOT_REQUIRED',
      fields: { configured: serving.map((b) => b.key) },
    });
  }
  return { ok: true, value: resolved?.key ?? null };
}

/** The caller's slug on the first attempt, then with a random suffix; a random slug when none. */
function slugFor(requested: string | undefined, attempt: number): string {
  if (!requested) return generateSlug();
  return attempt === 0 ? requested : `${requested}-${randomSuffix()}`;
}

/**
 * Creates a registration link for a coordinator.
 *
 * Tries the caller's slug first and adds a short random suffix on a collision;
 * without one it uses a random slug. A live link gets its public URL; a draft
 * gets none, since its slug can still change.
 *
 * @returns The link and its public URL, or the refusal the route answers with.
 */
export async function createRegistrationLink(input: CreateLinkInput): Promise<CreateLinkResult> {
  const { log } = input;
  const start = Date.now();
  const cfg = await getNetworkConfig();
  if (!cfg.domainIds.includes(input.domain)) {
    return fail({
      code: 'SCHEMA_VALIDATION',
      detail: `unknown domain '${input.domain}' — valid: ${cfg.domainIds.join(', ')}`,
      fields: { domain: 'invalid' },
    });
  }
  if (!input.servedDomains.includes(input.domain)) {
    return fail({
      code: 'DOMAIN_NOT_SERVED',
      fields: { requested_domain: input.domain, served_domains: [...input.servedDomains] },
    });
  }
  const mode = resolveMode(input.registrationMode, cfg);
  if (!mode.ok) return mode;
  const voiceBot = checkVoiceBotChoice(input.voiceBotKey, mode.value, input.domain, cfg);
  if (!voiceBot.ok) return voiceBot;

  const store = getRegistrationLinksStore();
  for (let attempt = 0; attempt < SLUG_RETRIES; attempt++) {
    const slug = slugFor(input.slug, attempt);
    const result = await store.create({
      aggregatorId: input.userId,
      slug,
      domain: input.domain,
      context: input.context ?? {},
      status: input.status,
      registrationMode: mode.value,
      voiceBotKey: voiceBot.value,
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
    });
    if (result.ok) {
      const link = result.value;
      const publicUrl = link.status === 'draft' ? null : buildPublicUrl(input.orgSlug, link.slug);
      return { ok: true, value: { link, publicUrl } };
    }
    if (result.error.code !== 'SLUG_COLLISION') {
      log.error({
        status: 'failure',
        sub: 'store.create',
        error: result.error.code,
        latency_ms: Date.now() - start,
      });
      return fail({ code: 'DB_UNAVAILABLE', cause: new Error(result.error.message) });
    }
    log.warn({ status: 'retry', reason: 'slug_collision', attempt, slug });
  }
  log.error({
    status: 'failure',
    reason: 'slug_retries_exhausted',
    latency_ms: Date.now() - start,
  });
  return fail({
    code: 'DUPLICATE_SLUG',
    detail: 'Could not allocate a unique slug for the link. Please retry.',
  });
}
