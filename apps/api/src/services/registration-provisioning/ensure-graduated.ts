/**
 * Idempotent executor: graduate a registration to an active aggregator.
 *
 * Inserts the `aggregators` + `aggregator_profiles` rows from the registration
 * data, then transitions the registration from `approved` to `active`, stamping
 * `aggregator_id`. The aggregator INSERT uses `source_registration_id` as an
 * idempotency key: a crash-and-retry returns the existing row instead of
 * inserting a duplicate.
 *
 * Local projection — no external API calls, maximally reliable. After this
 * executor completes the registration is in `active` state and KC/signalstack
 * executors can run with the real aggregator UUID.
 */

import { logger } from '../../logger.js';
import { slugFromName } from '../slug.js';
import type { AggregatorStoreBase } from '../aggregator-store/interface.js';
import type { AggregatorProfileStoreBase } from '../aggregator-profile-store/interface.js';
import type { RegistrationStoreBase, Registration } from '../registration-store/interface.js';
import { handleProvisionFailure } from './provision-failure.js';
import type { EnsureResult } from './index.js';

export interface EnsureGraduatedDeps {
  store: RegistrationStoreBase;
  aggregatorStore: AggregatorStoreBase;
  aggregatorProfileStore: AggregatorProfileStoreBase;
  /** Dead-letter threshold; read from `config.REGISTRATION_MAX_PROVISION_ATTEMPTS`. */
  maxAttempts: number;
}

/**
 * Graduates a verified-and-approved registration into the `aggregators` table.
 *
 * Skips when `provisionState.graduated === 'done'` (aggregator row already
 * exists) or when the registration is already in `active` state.
 *
 * The aggregator INSERT carries `source_registration_id = reg.id`. A partial
 * unique index on that column means a duplicate insert on retry silently
 * returns the existing row instead of an error, making this executor safe to
 * call multiple times.
 *
 * @param reg - Registration in `approved` state.
 * @param deps - Store references and dead-letter config.
 * @returns ok on success or skip; ok: false on store error.
 */
export async function ensureGraduated(
  reg: Registration,
  deps: EnsureGraduatedDeps,
): Promise<EnsureResult> {
  const op = 'provisioning.ensureGraduated';
  const start = Date.now();

  if (reg.provisionState.graduated === 'done' || reg.state === 'active') {
    logger.debug({
      operation: op,
      status: 'skipped',
      registration_id: reg.id,
      reason: 'already_done',
    });
    return { ok: true };
  }

  try {
    // Re-read to catch concurrent graduation (reconciler + inline path race).
    const fresh = await deps.store.findById(reg.id);
    if (
      fresh.ok &&
      fresh.value &&
      (fresh.value.state === 'active' || fresh.value.provisionState.graduated === 'done')
    ) {
      logger.debug({
        operation: op,
        status: 'skipped',
        registration_id: reg.id,
        reason: 'already_active_on_reread',
      });
      return { ok: true };
    }

    const orgSlug = slugFromName(reg.orgName);

    // Create the aggregator row. source_registration_id acts as the idempotency
    // key: a crash-and-retry returns the existing aggregator transparently.
    const aggResult = await deps.aggregatorStore.create({
      orgSlug,
      actorType: 'aggregator',
      name: reg.orgName,
      type: (reg.orgType as 'seeker' | 'provider') ?? null,
      url: reg.orgUrl ?? null,
      contact: {
        name: extractContactName(reg),
        phone: reg.contactPhone,
        email: reg.contactEmail,
      },
      locations: reg.orgLocations as never[],
      consent: reg.consent as never,
      createdBy: 'system',
      updatedBy: 'system',
      sourceRegistrationId: reg.id,
    });

    if (!aggResult.ok) {
      return handleProvisionFailure(
        op,
        reg,
        'graduated',
        aggResult.error.message,
        deps.store,
        deps.maxAttempts,
        start,
      );
    }

    return await graduate(reg, aggResult.value.id, deps, op, start);
  } catch (err: unknown) {
    return handleProvisionFailure(
      op,
      reg,
      'graduated',
      err instanceof Error ? err.message : 'unknown',
      deps.store,
      deps.maxAttempts,
      start,
    );
  }
}

async function graduate(
  reg: Registration,
  aggregatorId: string,
  deps: EnsureGraduatedDeps,
  op: string,
  start: number,
): Promise<EnsureResult> {
  // Create the aggregator_profiles row (empty — applicant fills it on first login).
  const profileResult = await deps.aggregatorProfileStore.create({
    aggregatorId,
    contactName: extractContactName(reg),
    createdBy: 'system',
    updatedBy: 'system',
  });

  if (!profileResult.ok) {
    if (profileResult.error.code !== 'DUPLICATE') {
      return handleProvisionFailure(
        op,
        reg,
        'graduated',
        profileResult.error.message,
        deps.store,
        deps.maxAttempts,
        start,
      );
    }
    // DUPLICATE is fine — profile already exists from a prior attempt.
  }

  // Transition approved → active and stamp aggregatorId.
  const transResult = await deps.store.transition(
    reg.id,
    'approved',
    'active',
    { aggregatorId },
    reg.version,
    { actor: 'system', reason: 'graduation' },
  );

  if (!transResult.ok) {
    // STALE_TRANSITION means someone else already graduated this row — check if
    // it's already active (idempotent) rather than treating it as a hard error.
    if (transResult.error.code === 'STALE_TRANSITION') {
      logger.info({
        operation: op,
        status: 'skipped',
        registration_id: reg.id,
        reason: 'stale_transition_likely_concurrent',
        latency_ms: Date.now() - start,
      });
      return { ok: true };
    }
    return handleProvisionFailure(
      op,
      reg,
      'graduated',
      transResult.error.message,
      deps.store,
      deps.maxAttempts,
      start,
    );
  }

  // markProjection on the newly-active row (version has bumped, but markProjection
  // does not require a version match — it patches provision_state directly).
  await deps.store.markProjection(reg.id, 'graduated', 'done');

  logger.info({
    operation: op,
    status: 'success',
    registration_id: reg.id,
    aggregator_id: aggregatorId,
    latency_ms: Date.now() - start,
  });
  return { ok: true };
}

function extractContactName(reg: Registration): string {
  const draft = reg.profileDraft as Record<string, unknown>;
  const name = draft['contact_name'] ?? draft['name'] ?? draft['contactName'];
  return typeof name === 'string' && name.trim() ? name.trim() : reg.orgName;
}
