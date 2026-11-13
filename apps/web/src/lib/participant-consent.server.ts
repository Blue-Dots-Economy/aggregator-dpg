/**
 * Server-side loader for the participant consent text (Terms / Privacy) on the
 * public registration form.
 *
 * Reads `GET /v1/participant-consent` first. When that has no document, falls
 * back to `config/<network>[/<brand>]/schemas/participant/consent.json`.
 *
 * Returns null instead of throwing, so consent problems never break the public
 * page. Operator consent (`schemas/aggregator/`) is loaded elsewhere.
 *
 * @module apps/web/src/lib/participant-consent.server
 */

import 'server-only';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  ConsentStatementVersionSchema,
  ParticipantConsentDocSchema,
} from '@aggregator-dpg/network-config/interface';
import { z } from 'zod';
import { resolveSchemaRoot } from './config-paths';
import { logger } from './logger';
import { summariseIssues } from './response-shape-error';
import type { ConsentDocContent, ParticipantConsent } from '../components/consent/consent-types';

export type { ParticipantConsent };

/** Default grievances/support contact rendered into the `__SUPPORT_EMAIL__` token. */
const DEFAULT_SUPPORT_EMAIL = 'hello@bluedotseconomy.org';

/** Explicit timeout for the `GET /v1/participant-consent` fetch. */
const FETCH_TIMEOUT_MS = 5_000;

const ConsentDocSchema = ParticipantConsentDocSchema.shape.documents.shape.terms.unwrap();

/** A Signals `consent.json` document (`terms` / `privacy`). */
type ConsentDoc = z.infer<typeof ConsentDocSchema>;

/**
 * The participant `consent.json` this loader reads, from the API or from disk.
 * A profile-creation `statement` may be missing; it is shown as empty text.
 */
const ParticipantConsentFileSchema = z.object({
  documents: z.object({
    terms: ConsentDocSchema.optional(),
    privacy: ConsentDocSchema.optional(),
    profile_creation: z
      .object({
        current_version: z.number(),
        versions: z.array(
          ConsentStatementVersionSchema.extend({ statement: z.string().optional() }),
        ),
      })
      .optional(),
  }),
});

/** The parsed participant `consent.json`. */
type ParticipantConsentFile = z.infer<typeof ParticipantConsentFileSchema>;

/** The body of `GET /v1/participant-consent`. */
const ParticipantConsentResponseSchema = z.object({ participant_consent: z.unknown() });

/**
 * Reads a participant consent document, logging the field paths of a wrong shape.
 *
 * @param value - The parsed document.
 * @param operation - The log operation name.
 * @returns The document, or `null` when it has the wrong shape.
 */
function readConsentFile(value: unknown, operation: string): ParticipantConsentFile | null {
  const parsed = ParticipantConsentFileSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger.warn({
    operation,
    status: 'failure',
    error: 'unexpected consent document shape',
    issues: summariseIssues(parsed.error.issues),
  });
  return null;
}

/**
 * Resolves `schemas/participant/consent.json` under the active network/brand.
 *
 * Tries the configured schema root first, then cwd-relative paths.
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
    ...(v?.effective_from ? { effective_from: v.effective_from } : {}),
  };
}

/**
 * Shapes a parsed consent file into the view DTO and fills in `__SUPPORT_EMAIL__`.
 *
 * Returns null when Terms or Privacy is missing.
 */
function shapeParticipantConsent(
  parsed: ParticipantConsentFile,
  supportEmail: string,
): ParticipantConsent | null {
  const { terms, privacy, profile_creation: pc } = parsed.documents;
  if (!terms?.versions.length || !privacy?.versions.length) return null;
  const pcVersion = pc?.versions.find((x) => x.version === pc.current_version) ?? pc?.versions[0];
  return {
    terms: toCurrent(terms, supportEmail),
    privacy: toCurrent(privacy, supportEmail),
    ...(pcVersion
      ? {
          profileCreation: {
            version: pcVersion.version,
            statement: (pcVersion.statement ?? '').replaceAll('__SUPPORT_EMAIL__', supportEmail),
          },
        }
      : {}),
  };
}

/**
 * Fetches the participant consent document from the aggregator API.
 *
 * Returns null on any failure or when there is no document.
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
    const body = ParticipantConsentResponseSchema.safeParse(await res.json());
    if (!body.success || body.data.participant_consent === null) return null;
    return readConsentFile(body.data.participant_consent, 'participantConsent.loadFromApi');
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
 * Reads the on-disk participant consent document, or null when missing or malformed.
 */
async function loadFromDisk(): Promise<ParticipantConsentFile | null> {
  const file = resolveParticipantConsentPath();
  if (!file) return null;
  try {
    return readConsentFile(
      JSON.parse(await readFile(file, 'utf8')),
      'participantConsent.loadFromDisk',
    );
  } catch {
    return null;
  }
}

/**
 * Loads the current participant Terms and Privacy text for the registration
 * consent modal.
 *
 * Prefers the API, then the on-disk copy. Returns null when neither is usable;
 * the form then shows a plain checkbox label. Never throws.
 *
 * @returns The versioned Terms/Privacy (+ profile-creation) content, or null.
 */
export async function loadParticipantConsent(): Promise<ParticipantConsent | null> {
  const supportEmail = process.env.CONSENT_SUPPORT_EMAIL?.trim() || DEFAULT_SUPPORT_EMAIL;
  // Consent problems must never throw to the page.
  try {
    const fromApi = await loadFromApi();
    const shapedApi = fromApi ? shapeParticipantConsent(fromApi, supportEmail) : null;
    if (shapedApi) return shapedApi;
    // Fall back to the on-disk copy.
    const fromDisk = await loadFromDisk();
    return fromDisk ? shapeParticipantConsent(fromDisk, supportEmail) : null;
  } catch {
    return null;
  }
}
