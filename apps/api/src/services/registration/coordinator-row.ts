/**
 * Coordinator row creation shared by the invite-accept route and the owner
 * self-add (`@aggregator-dpg/api`): the slug retry loop and the consent-ledger
 * hook that `store.create` runs inside its transaction.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type {
  BecknContact,
  BecknLocation,
  RegistrationConsentSchema,
} from '@aggregator-dpg/shared-primitives/aggregator';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { getConsentLedger } from '../consent-ledger/index.js';
import type { getUserStore } from '../user-store/index.js';
import type { LegacyOrgDetails, RecordConsentHook } from '../user-store/interface.js';
import { slugFromName } from '../slug.js';

/** Inserts tried before giving up; each draws a new random slug suffix. */
const SLUG_RETRIES = 3;

/** A registration consent after server stamping (`stampConsent`). */
export type RegistrationConsent = z.infer<typeof RegistrationConsentSchema>;

/**
 * Builds the consent-ledger write that `store.create` runs inside its transaction.
 *
 * The consent config is read now, before the transaction. A failed ledger
 * write throws, so the store rolls back and answers `CONSENT_WRITE_FAILED`.
 *
 * @param consent - The server-stamped registration consent (`valid_till` is stored).
 * @param log - Request-scoped child logger.
 * @returns The hook to pass as `recordConsent`, or `null` when the consent config cannot be read (logged).
 */
export async function aggregatorConsentWriter({
  consent,
  log,
}: {
  consent: RegistrationConsent;
  log: FastifyBaseLogger;
}): Promise<RecordConsentHook | null> {
  const { network, brand } = resolveActiveNetwork();
  let termsVersion: number;
  let privacyVersion: number;
  try {
    const consentCfg = await loadConsentConfig(network, brand);
    termsVersion = consentCfg.audiences.aggregator.documents.terms.current_version;
    privacyVersion = consentCfg.audiences.aggregator.documents.privacy.current_version;
  } catch (e) {
    log.error(
      {
        operation: 'consentLedger.recordAggregatorConsent',
        status: 'failure',
        error: e instanceof Error ? e.message : String(e),
        network,
        brand: brand ?? null,
      },
      'consent config load failed — registration refused',
    );
    return null;
  }

  return async (executor, aggregatorId) => {
    const result = await getConsentLedger()
      .withExecutor(executor)
      .recordRegistrationConsent({
        subjectType: 'user',
        subjectId: aggregatorId,
        network,
        brand: brand ?? null,
        termsVersion,
        privacyVersion,
        validTill: new Date(consent.valid_till),
      });
    if (!result.success) {
      log.error(
        {
          operation: 'consentLedger.recordAggregatorConsent',
          status: 'failure',
          error: result.error.message,
          error_type: result.error.name,
          aggregator_id: aggregatorId,
          network,
          brand: brand ?? null,
          terms_version: termsVersion,
          privacy_version: privacyVersion,
        },
        'consent ledger write failed — registration rolled back',
      );
      // Throwing inside the store's transaction rolls the registration back.
      throw result.error;
    }
  };
}

/**
 * Inserts a coordinator, retrying up to {@link SLUG_RETRIES} times on a slug collision.
 *
 * @param store - The user store.
 * @param name - Display name; the slug is derived from it.
 * @param extras - The rest of the row.
 * @returns The store's result; never throws.
 */
export async function createAggregatorWithSlug(
  store: ReturnType<typeof getUserStore>,
  name: string,
  extras: {
    /** The domains served, validated and non-empty. */
    domains: string[];
    contact: BecknContact;
    consent: RegistrationConsent;
    /** Writes the consent ledger row inside the create transaction. */
    recordConsent: RecordConsentHook;
    /** The coordinator's org (`users.org_id`). */
    orgId: string;
    /** The coordinator's own org details (Default-org registrations only). */
    legacyOrgDetails: LegacyOrgDetails | null;
    /** The coordinator's own address (`users.locations`). */
    locations: BecknLocation[];
    /** The consumed invite's `jti`, when registered via one. */
    inviteId: string | null;
    profile: Record<string, unknown>;
    /** `null` when no registration schema resolved. */
    profileRef: string | null;
    /** Audit actor for `created_by` / `updated_by`; `self` for a registrant. */
    createdBy?: string;
  },
): ReturnType<typeof store.create> {
  const createdBy = extras.createdBy ?? 'self';
  let last: Awaited<ReturnType<typeof store.create>> | null = null;
  for (let attempt = 0; attempt < SLUG_RETRIES; attempt += 1) {
    const orgSlug = slugFromName(name);
    last = await store.create({
      orgSlug,
      name,
      type: extras.domains[0] ?? null,
      serves: extras.domains,
      contact: extras.contact,
      consent: extras.consent,
      recordConsent: extras.recordConsent,
      createdBy,
      updatedBy: createdBy,
      orgId: extras.orgId,
      legacyOrgDetails: extras.legacyOrgDetails,
      locations: extras.locations,
      inviteId: extras.inviteId,
      profile: extras.profile,
      profileRef: extras.profileRef,
    });
    if (last.ok) return last;
    if (last.error.code !== 'DUPLICATE_SLUG') return last;
  }
  return (
    last ?? {
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'slug retries exhausted' },
    }
  );
}
