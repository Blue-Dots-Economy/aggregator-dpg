/**
 * Server-side loader for the PARTICIPANT consent copy (Terms / Privacy) shown
 * on the public registration form.
 *
 * Source precedence (all best-effort — a consent-copy problem must never take
 * down the public page, so this module never throws):
 *   1. `PARTICIPANT_CONSENT_URL` env override — an explicit external URL.
 *   2. The brand's `participant_consent_url` from `GET /v1/aggregator-config`
 *      (declared in `config/<network>[/<brand>]/aggregator.config.yaml`).
 *   3. On-disk copy at `config/<network>[/<brand>]/schemas/participant/
 *      consent.json` (the interim #522 source, copied verbatim from Signals).
 *
 * When a URL source (1 or 2) is configured it is fetched and normalised
 * (GitHub `blob` view URLs → `raw.githubusercontent.com`), with a fetch
 * timeout and a success-only in-process TTL cache; a fetch/parse failure
 * transparently falls back to the on-disk copy. This is scoped to the
 * registration LINK only — the aggregator's OWN operator consent
 * (`schemas/aggregator/`) is loaded separately and unaffected.
 *
 * INTERIM (#522): the eventual authoritative source is Signals' public
 * `GET /api/v1/consent/active?network=&audience=participant&variant=adult`.
 * The returned {@link ParticipantConsent} shape (and every caller) stays
 * unchanged when that endpoint lands.
 *
 * @module apps/web/src/lib/participant-consent.server
 */

import 'server-only';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveSchemaRoot } from './config-paths';
import { logger } from './logger';
import type { ConsentDocContent, ParticipantConsent } from '../components/consent/consent-types';

export type { ParticipantConsent };

/** Default grievances/support contact rendered into the `__SUPPORT_EMAIL__` token. */
const DEFAULT_SUPPORT_EMAIL = 'hello@bluedotseconomy.org';

/** Explicit timeout for every external fetch this loader makes (config + document). */
const FETCH_TIMEOUT_MS = 5_000;

/** Success-only TTL for the fetched-URL consent cache. */
const URL_CACHE_TTL_MS = 10 * 60 * 1000;

/** One version entry inside a Signals `consent.json` document. */
interface ConsentVersion {
  version: number;
  title: string;
  content: string;
  effective_from?: string;
}

/** A Signals `consent.json` document (`terms` / `privacy`). */
interface ConsentDoc {
  current_version: number;
  versions: ConsentVersion[];
}

/** Profile-creation consent document — a short `statement`, not title+content. */
interface StatementDoc {
  current_version: number;
  versions: { version: number; statement: string; effective_from?: string }[];
}

/** The subset of the Signals participant `consent.json` this loader reads. */
interface ParticipantConsentFile {
  documents?: { terms?: ConsentDoc; privacy?: ConsentDoc; profile_creation?: StatementDoc };
}

/**
 * Success-only cache keyed by the *configured* (pre-normalisation) URL, so a
 * healthy external source is fetched at most once per {@link URL_CACHE_TTL_MS}.
 */
const urlCache = new Map<string, { value: ParticipantConsent; expiresAt: number }>();

/**
 * Resolves `schemas/participant/consent.json` under the active network/brand.
 * `CONFIG_ROOT` (Kubernetes mount) wins; otherwise falls back to the first
 * cwd-relative candidate that exists (dev vs Docker cwd).
 *
 * @returns Absolute path to the participant consent file, or null if none found.
 */
function resolveParticipantConsentPath(): string | null {
  const candidates = [
    path.join(resolveSchemaRoot(), 'participant', 'consent.json'),
    path.resolve(process.cwd(), '../../config/blue_dot/schemas/participant/consent.json'),
    path.resolve(process.cwd(), '../config/blue_dot/schemas/participant/consent.json'),
    path.resolve(process.cwd(), 'config/blue_dot/schemas/participant/consent.json'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * Normalises a GitHub `blob` view URL to its `raw.githubusercontent.com`
 * equivalent so the fetched body is the raw JSON file, not the HTML page.
 * Non-GitHub or already-raw URLs pass through unchanged.
 *
 * @param url - The configured consent source URL.
 * @returns A URL whose body is the raw JSON document.
 */
export function normalizeConsentUrl(url: string): string {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : url;
}

/**
 * Picks the current-version entry of a consent document and renders the
 * `__SUPPORT_EMAIL__` token to the deploy-time support address.
 */
function toCurrent(doc: ConsentDoc, supportEmail: string): ConsentDocContent['terms'] {
  const v = doc.versions.find((x) => x.version === doc.current_version) ?? doc.versions[0];
  return {
    version: v?.version ?? doc.current_version,
    title: v?.title ?? '',
    content: (v?.content ?? '').replaceAll('__SUPPORT_EMAIL__', supportEmail),
  };
}

/**
 * Shapes a parsed participant consent file into the view DTO, rendering the
 * `__SUPPORT_EMAIL__` token throughout. Returns null when the required Terms
 * or Privacy documents are missing so callers can fall back.
 */
function shapeParticipantConsent(
  parsed: ParticipantConsentFile,
  supportEmail: string,
): ParticipantConsent | null {
  const terms = parsed.documents?.terms;
  const privacy = parsed.documents?.privacy;
  if (!terms?.versions?.length || !privacy?.versions?.length) return null;
  const pc = parsed.documents?.profile_creation;
  const pcVersion = pc?.versions?.find((x) => x.version === pc.current_version) ?? pc?.versions[0];
  return {
    terms: toCurrent(terms, supportEmail),
    privacy: toCurrent(privacy, supportEmail),
    ...(pcVersion
      ? {
          profileCreation: {
            version: pcVersion.version,
            statement: pcVersion.statement.replaceAll('__SUPPORT_EMAIL__', supportEmail),
          },
        }
      : {}),
  };
}

/**
 * Resolves the external participant-consent source URL. `PARTICIPANT_CONSENT_URL`
 * env wins; otherwise the brand's `participant_consent_url` read from the API's
 * `GET /v1/aggregator-config`. Best-effort — returns null (loader falls back to
 * the on-disk copy) on any failure, never throwing.
 *
 * @returns The configured consent URL, or null when none is set / reachable.
 */
async function resolveConsentUrl(): Promise<string | null> {
  const envUrl = process.env.PARTICIPANT_CONSENT_URL?.trim();
  if (envUrl) return envUrl;

  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
  const start = Date.now();
  try {
    const res = await fetch(`${apiBase}/v1/aggregator-config`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({
        operation: 'participantConsent.resolveConsentUrl',
        status: 'failure',
        error: `aggregator-config HTTP ${res.status}`,
        latency_ms: Date.now() - start,
      });
      return null;
    }
    const cfg = (await res.json()) as { brand?: { participant_consent_url?: string } };
    return cfg.brand?.participant_consent_url?.trim() || null;
  } catch (err) {
    logger.warn({
      operation: 'participantConsent.resolveConsentUrl',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
    return null;
  }
}

/**
 * Fetches and shapes participant consent from an external URL, normalising a
 * GitHub `blob` URL to raw first. Cached on success for {@link URL_CACHE_TTL_MS}.
 * Best-effort — returns null on timeout / non-2xx / malformed body so the
 * caller falls back to the on-disk copy.
 */
async function loadFromUrl(url: string, supportEmail: string): Promise<ParticipantConsent | null> {
  const cached = urlCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const target = normalizeConsentUrl(url);
  const start = Date.now();
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      logger.warn({
        operation: 'participantConsent.loadFromUrl',
        status: 'failure',
        error: `HTTP ${res.status}`,
        latency_ms: Date.now() - start,
      });
      return null;
    }
    const parsed = (await res.json()) as ParticipantConsentFile;
    const shaped = shapeParticipantConsent(parsed, supportEmail);
    if (shaped) {
      urlCache.set(url, { value: shaped, expiresAt: Date.now() + URL_CACHE_TTL_MS });
      logger.info({
        operation: 'participantConsent.loadFromUrl',
        status: 'success',
        latency_ms: Date.now() - start,
      });
    }
    return shaped;
  } catch (err) {
    logger.warn({
      operation: 'participantConsent.loadFromUrl',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
    return null;
  }
}

/**
 * Reads and shapes participant consent from the on-disk copy. Returns null
 * when the file is missing or malformed — never throws.
 */
async function loadFromDisk(supportEmail: string): Promise<ParticipantConsent | null> {
  const file = resolveParticipantConsentPath();
  if (!file) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as ParticipantConsentFile;
    return shapeParticipantConsent(parsed, supportEmail);
  } catch {
    return null;
  }
}

/**
 * Loads the participant Terms + Privacy copy at their current versions for the
 * public registration form's consent modal. Prefers the brand-configured
 * external URL (env override → aggregator-config), falling back to the on-disk
 * copy. Returns null (form falls back to a plain checkbox label) when no source
 * yields usable content — never throws, so a consent-copy problem can't take
 * down the public page.
 *
 * @returns The versioned Terms/Privacy (+ profile-creation) content, or null.
 */
export async function loadParticipantConsent(): Promise<ParticipantConsent | null> {
  const supportEmail = process.env.CONSENT_SUPPORT_EMAIL?.trim() || DEFAULT_SUPPORT_EMAIL;
  const url = await resolveConsentUrl();
  if (url) {
    const fromUrl = await loadFromUrl(url, supportEmail);
    if (fromUrl) return fromUrl;
    // URL configured but unreachable/malformed — fall back to the on-disk copy.
  }
  return loadFromDisk(supportEmail);
}
