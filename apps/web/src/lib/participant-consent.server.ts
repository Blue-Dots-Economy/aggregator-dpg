/**
 * Server-side loader for the PARTICIPANT consent copy (Terms / Privacy) shown
 * on the public registration form.
 *
 * The authoritative source is the aggregator API's `GET /v1/participant-consent`,
 * which serves the participant `consent.json` the network-config loader fetches
 * from `aggregator.network.consent_source` — the same cache-backed HTTPS pull as
 * `network.json` (env override `AGGREGATOR_CONSENT_SOURCE`). When that endpoint
 * yields no document (no `consent_source` configured, or its fetch failed with
 * no cached copy) this loader falls back to the on-disk copy at
 * `config/<network>[/<brand>]/schemas/participant/consent.json`.
 *
 * This is best-effort — a consent-copy problem must never take down the public
 * page, so every path returns null rather than throwing. It is scoped to the
 * registration LINK only; the aggregator's OWN operator consent
 * (`schemas/aggregator/`) is loaded separately and unaffected.
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

/** Explicit timeout for the `GET /v1/participant-consent` fetch. */
const FETCH_TIMEOUT_MS = 5_000;

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
 * Fetches the resolved participant consent document from the aggregator API.
 * Best-effort — returns null on timeout / non-2xx / malformed body / absent
 * document so the caller falls back to the on-disk copy.
 */
async function loadFromApi(): Promise<ParticipantConsentFile | null> {
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
  const start = Date.now();
  try {
    const res = await fetch(`${apiBase}/v1/participant-consent`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({
        operation: 'participantConsent.loadFromApi',
        status: 'failure',
        error: `HTTP ${res.status}`,
        latency_ms: Date.now() - start,
      });
      return null;
    }
    const body = (await res.json()) as { participant_consent?: ParticipantConsentFile | null };
    return body.participant_consent ?? null;
  } catch (err) {
    logger.warn({
      operation: 'participantConsent.loadFromApi',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
    return null;
  }
}

/**
 * Reads the participant consent document from the on-disk copy. Returns null
 * when the file is missing or malformed — never throws.
 */
async function loadFromDisk(): Promise<ParticipantConsentFile | null> {
  const file = resolveParticipantConsentPath();
  if (!file) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8')) as ParticipantConsentFile;
  } catch {
    return null;
  }
}

/**
 * Loads the participant Terms + Privacy copy at their current versions for the
 * public registration form's consent modal. Prefers the API-served document
 * (fetched by the network-config loader from `consent_source`), falling back to
 * the on-disk copy. Returns null (form falls back to a plain checkbox label)
 * when no source yields usable content — never throws, so a consent-copy problem
 * can't take down the public page.
 *
 * @returns The versioned Terms/Privacy (+ profile-creation) content, or null.
 */
export async function loadParticipantConsent(): Promise<ParticipantConsent | null> {
  const supportEmail = process.env.CONSENT_SUPPORT_EMAIL?.trim() || DEFAULT_SUPPORT_EMAIL;
  const fromApi = await loadFromApi();
  const shapedApi = fromApi ? shapeParticipantConsent(fromApi, supportEmail) : null;
  if (shapedApi) return shapedApi;
  // API had no usable document — fall back to the on-disk copy.
  const fromDisk = await loadFromDisk();
  return fromDisk ? shapeParticipantConsent(fromDisk, supportEmail) : null;
}
