/**
 * Consent status read service, in the aggregator API (`@aggregator-dpg/api`).
 *
 * Answers whether the signed-in caller holds a valid acceptance of the current
 * terms and privacy versions, read from the consent ledger (`consent_record`).
 * A coordinator accepts for itself; an org owner accepts once per owned org.
 * The ledger package stays write-only, so this service reads the table directly.
 */

import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { BaseError, errorType } from '@aggregator-dpg/shared-primitives/errors';
import { ok, err, type Result } from '@aggregator-dpg/shared-primitives/result';
import { getDb } from '../db/client.js';
import { consentRecord } from '../db/schema.js';
import { logger } from '../logger.js';
import { ACCEPTED_CONSENT_SOURCES } from './consent-sources.js';
import type { Actor } from './auth/actor/index.js';

/** The consent audience whose document versions apply: coordinators or org owners. */
export type ConsentAudience = 'aggregator' | 'org';

/** One ledger subject whose acceptance is checked. */
export interface ConsentSubjectRef {
  subjectType: 'user' | 'organisation';
  subjectId: string;
}

/** Whether the caller still has to accept the current terms. */
export interface ConsentStatus {
  outstanding: boolean;
  audience: ConsentAudience;
  termsVersion: number;
  privacyVersion: number;
  /** Owned orgs that have not accepted; empty for a coordinator. */
  outstandingOrgIds: string[];
}

export { ACCEPTED_CONSENT_SOURCES } from './consent-sources.js';

/** Current terms and privacy versions of one audience. */
interface AudienceVersions {
  termsVersion: number;
  privacyVersion: number;
}

type ConsentVersions = Record<ConsentAudience, AudienceVersions>;

/**
 * Lists the ledger subjects whose acceptance the caller needs, and the
 * audience whose versions apply.
 *
 * A coordinator is one `user` subject. An owner is one `organisation` subject
 * per owned org, without the network facilitator root and the Default org:
 * their owners come from config and never register.
 *
 * @param actor - The resolved caller.
 * @returns The audience and the subjects, possibly none.
 */
export function consentSubjectsOf(actor: Actor): {
  audience: ConsentAudience;
  subjects: ConsentSubjectRef[];
} {
  if (actor.userType === 'coordinator') {
    return {
      audience: 'aggregator',
      subjects: [{ subjectType: 'user', subjectId: actor.userId }],
    };
  }
  return {
    audience: 'org',
    subjects: actor.orgs
      .filter((o) => o.relation === 'owner' && o.orgType === 'aggregator' && !o.isDefault)
      .map((o) => ({ subjectType: 'organisation', subjectId: o.id })),
  };
}

/** Loaded once per process; cleared on failure so a later call retries. */
let versionsCache: Promise<ConsentVersions> | null = null;

/** Reads the current versions of both audiences from the instance's consent config. */
async function loadVersions(): Promise<ConsentVersions> {
  const { network, brand } = resolveActiveNetwork();
  const cfg = await loadConsentConfig(network, brand);
  const of = (audience: ConsentAudience): AudienceVersions => ({
    termsVersion: cfg.audiences[audience].documents.terms.current_version,
    privacyVersion: cfg.audiences[audience].documents.privacy.current_version,
  });
  return { aggregator: of('aggregator'), org: of('org') };
}

/**
 * Returns the current terms and privacy versions of an audience.
 *
 * The consent config is read on first use and kept for the life of the process.
 *
 * @param audience - Coordinators (`aggregator`) or org owners (`org`).
 * @returns The versions, or a `CONSENT_CONFIG_UNAVAILABLE` error.
 */
export async function currentConsentVersions(
  audience: ConsentAudience,
): Promise<Result<AudienceVersions, BaseError>> {
  versionsCache ??= loadVersions();
  try {
    return ok((await versionsCache)[audience]);
  } catch (e) {
    versionsCache = null;
    logger.error({
      operation: 'consentStatus.loadVersions',
      status: 'failure',
      error_type: errorType(e),
    });
    return err(
      new BaseError('CONSENT_CONFIG_UNAVAILABLE', 'consent config could not be read', { cause: e }),
    );
  }
}

/**
 * Returns the subject ids among `subjects` that hold a valid acceptance of
 * the given versions: an accepted source, matching versions and a `valid_till`
 * in the future.
 */
async function acceptedSubjectIds(
  subjects: ConsentSubjectRef[],
  versions: AudienceVersions,
): Promise<Set<string>> {
  const first = subjects[0];
  if (!first) return new Set();
  const rows = await getDb()
    .select({ subjectId: consentRecord.subjectId })
    .from(consentRecord)
    .where(
      and(
        eq(consentRecord.subjectType, first.subjectType),
        inArray(
          consentRecord.subjectId,
          subjects.map((s) => s.subjectId),
        ),
        eq(consentRecord.termsVersion, versions.termsVersion),
        eq(consentRecord.privacyVersion, versions.privacyVersion),
        inArray(consentRecord.source, [...ACCEPTED_CONSENT_SOURCES]),
        isNotNull(consentRecord.validTill),
        gt(consentRecord.validTill, sql`now()`),
      ),
    )
    .groupBy(consentRecord.subjectId);
  return new Set(rows.map((r) => r.subjectId));
}

type ConsentStatusReader = (actor: Actor) => Promise<Result<ConsentStatus, BaseError>>;

let override: ConsentStatusReader | null = null;

/** Test helper; replaces the status read (null restores the Postgres read). */
export function _setConsentStatusReader(r: ConsentStatusReader | null): void {
  override = r;
}

/**
 * Reports whether the caller still has to accept the current terms and
 * privacy versions.
 *
 * @param actor - The resolved caller.
 * @returns The status, or `CONSENT_CONFIG_UNAVAILABLE` / `DB_UNAVAILABLE`.
 */
export async function getConsentStatus(actor: Actor): Promise<Result<ConsentStatus, BaseError>> {
  if (override) return override(actor);
  const { audience, subjects } = consentSubjectsOf(actor);
  const versions = await currentConsentVersions(audience);
  if (!versions.success) return versions;

  const start = Date.now();
  let accepted: Set<string>;
  try {
    accepted = await acceptedSubjectIds(subjects, versions.value);
  } catch (e) {
    logger.error({
      operation: 'consentStatus.read',
      status: 'failure',
      error_type: errorType(e),
      latency_ms: Date.now() - start,
      user_id: actor.userId,
    });
    return err(new BaseError('DB_UNAVAILABLE', 'consent_record read failed', { cause: e }));
  }

  const missing = subjects.filter((s) => !accepted.has(s.subjectId));
  return ok({
    outstanding: missing.length > 0,
    audience,
    termsVersion: versions.value.termsVersion,
    privacyVersion: versions.value.privacyVersion,
    outstandingOrgIds: missing
      .filter((s) => s.subjectType === 'organisation')
      .map((s) => s.subjectId),
  });
}
