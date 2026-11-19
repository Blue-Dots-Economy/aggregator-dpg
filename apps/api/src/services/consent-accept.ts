/**
 * Consent accept service, in the aggregator API (`@aggregator-dpg/api`).
 *
 * Records the signed-in caller's acceptance of the current terms and privacy
 * versions in the consent ledger, with source `first-login`. A coordinator
 * accepts for itself; an org owner accepts for every owned org still to
 * accept, in one transaction, so either every org is recorded or none is.
 */

import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { BaseError, DomainError, errorType } from '@aggregator-dpg/shared-primitives/errors';
import { ok, err, type Result } from '@aggregator-dpg/shared-primitives/result';
import { getDb } from '../db/client.js';
import { logger } from '../logger.js';
import type { Actor } from './auth/actor/index.js';
import { getConsentLedger } from './consent-ledger/index.js';
import { getConsentStatus, type ConsentSubjectRef } from './consent-status.js';
import { MAX_CONSENT_VALIDITY_MS } from './registration-consent.js';

/** Ledger source of an acceptance given on the terms screen after sign-in. */
const FIRST_LOGIN_SOURCE = 'first-login';

/** The document versions the caller was shown and accepted. */
export interface ShownConsentVersions {
  termsVersion: number;
  privacyVersion: number;
}

/** Carries a failed ledger write out of the transaction so it rolls back. */
class LedgerWriteFailed extends Error {
  constructor(readonly error: BaseError) {
    super(error.message, { cause: error });
  }
}

type ConsentAcceptor = (
  actor: Actor,
  shown: ShownConsentVersions,
  now?: Date,
) => Promise<Result<{ recorded: number }, BaseError>>;

let override: ConsentAcceptor | null = null;

/** Test helper; replaces the accept service (null restores the Postgres write). */
export function _setConsentAcceptor(a: ConsentAcceptor | null): void {
  override = a;
}

/**
 * Records the caller's acceptance of the current terms for every subject
 * still to accept.
 *
 * Nothing is written when nothing is outstanding, so a repeated call records 0.
 *
 * @param actor - The resolved caller.
 * @param shown - The versions the caller was shown; must be the current ones.
 * @param now - The acceptance time; `valid_till` is this plus the maximum validity.
 * @returns The number of rows written, or `CONSENT_VERSION_CHANGED`,
 *   `CONSENT_CONFIG_UNAVAILABLE` or `DB_UNAVAILABLE`.
 */
export async function acceptCurrentTerms(
  actor: Actor,
  shown: ShownConsentVersions,
  now: Date = new Date(),
): Promise<Result<{ recorded: number }, BaseError>> {
  if (override) return override(actor, shown, now);
  const operation = 'consentAccept.record';

  const status = await getConsentStatus(actor);
  if (!status.success) return status;
  const s = status.value;

  if (shown.termsVersion !== s.termsVersion || shown.privacyVersion !== s.privacyVersion) {
    logger.info({
      operation,
      status: 'skipped',
      error_code: 'CONSENT_VERSION_CHANGED',
      user_id: actor.userId,
    });
    return err(
      new DomainError('the terms or privacy version changed', { code: 'CONSENT_VERSION_CHANGED' }),
    );
  }

  const subjects: ConsentSubjectRef[] =
    s.audience === 'aggregator'
      ? s.outstanding
        ? [{ subjectType: 'user', subjectId: actor.userId }]
        : []
      : s.outstandingOrgIds.map((id) => ({ subjectType: 'organisation', subjectId: id }));
  const orgIds = s.outstandingOrgIds;

  if (subjects.length === 0) {
    logger.info({ operation, status: 'skipped', count: 0, user_id: actor.userId });
    return ok({ recorded: 0 });
  }

  const { network, brand } = resolveActiveNetwork();
  const validTill = new Date(now.getTime() + MAX_CONSENT_VALIDITY_MS);
  const start = Date.now();
  try {
    await getDb().transaction(async (tx) => {
      const ledger = getConsentLedger().withExecutor(tx);
      for (const subject of subjects) {
        const r = await ledger.recordRegistrationConsent({
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          network,
          brand: brand ?? null,
          termsVersion: s.termsVersion,
          privacyVersion: s.privacyVersion,
          validTill,
          source: FIRST_LOGIN_SOURCE,
        });
        if (!r.success) throw new LedgerWriteFailed(r.error);
      }
    });
  } catch (e) {
    logger.error({
      operation,
      status: 'failure',
      error_type: e instanceof LedgerWriteFailed ? e.error.code : errorType(e),
      latency_ms: Date.now() - start,
      count: subjects.length,
      user_id: actor.userId,
      org_ids: orgIds,
    });
    return err(new BaseError('DB_UNAVAILABLE', 'consent_record write failed', { cause: e }));
  }

  logger.info({
    operation,
    status: 'success',
    latency_ms: Date.now() - start,
    count: subjects.length,
    user_id: actor.userId,
    org_ids: orgIds,
  });
  return ok({ recorded: subjects.length });
}
