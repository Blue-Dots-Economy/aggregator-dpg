/**
 * Idempotent executor: upsert the aggregator's signalstack organisation.
 *
 * Calls `upsertAggregator` on the SignalStack writer, which is idempotent on
 * `external_id` (our aggregator UUID). Mirrors the returned `org_id` back
 * onto the registration via `markProjection`.
 *
 * Requires `reg.aggregatorId` to be set — must run after `ensureGraduated`.
 */

import { logger } from '../../logger.js';
import type { SignalStackWriterBase } from '@aggregator-dpg/signalstack-writer/interface';
import type { AggregatorStoreBase } from '../aggregator-store/interface.js';
import type { RegistrationStoreBase, Registration } from '../registration-store/interface.js';
import type { EnsureResult } from './index.js';

export interface EnsureSignalstackOrgDeps {
  store: RegistrationStoreBase;
  signalStackWriter: SignalStackWriterBase;
  aggregatorStore: AggregatorStoreBase;
}

/**
 * Ensures the aggregator has a registered signalstack organisation row.
 *
 * Skips when `provisionState.ss_org === 'done'`. Requires the registration to
 * have an `aggregatorId` set (i.e. `ensureGraduated` must have run first).
 *
 * @param reg - Registration in `approved` or `active` state.
 * @param deps - Store + signalstack writer.
 * @returns ok on success or skip; ok: false if graduation has not occurred or
 *   the upsert fails.
 */
export async function ensureSignalstackOrg(
  reg: Registration,
  deps: EnsureSignalstackOrgDeps,
): Promise<EnsureResult> {
  const op = 'provisioning.ensureSignalstackOrg';
  const start = Date.now();

  if (reg.provisionState.ss_org === 'done') {
    logger.debug({
      operation: op,
      status: 'skipped',
      registration_id: reg.id,
      reason: 'already_done',
    });
    return { ok: true };
  }

  if (!reg.aggregatorId) {
    // ensureGraduated has not run yet; the reconciler will retry on the next tick
    // after graduation completes and sets aggregatorId.
    logger.debug({
      operation: op,
      status: 'skipped',
      registration_id: reg.id,
      reason: 'awaiting_graduation',
    });
    return { ok: true };
  }

  try {
    // Look up the aggregator to get its slug (required by signalstack upsert).
    const aggResult = await deps.aggregatorStore.findById(reg.aggregatorId);
    if (!aggResult.ok || !aggResult.value) {
      const errMsg = aggResult.ok ? 'aggregator not found' : aggResult.error.message;
      return await failSsOrg(op, reg, errMsg, deps, start);
    }

    const upsertResult = await deps.signalStackWriter.upsertAggregator({
      external_id: reg.aggregatorId,
      name: aggResult.value.name,
      slug: aggResult.value.orgSlug,
    });

    // SignalStackWriterBase returns Result<T,BaseError> with `success` discriminant.
    if (!upsertResult.success) {
      return await failSsOrg(op, reg, upsertResult.error.message, deps, start);
    }

    // Mirror the signalstack org_id back onto the aggregator row for future
    // participant onboard calls (actingOrgId header).
    const ssOrgId = upsertResult.value.org_id;
    await deps.aggregatorStore.updateSignalstackOrgId(reg.aggregatorId, ssOrgId, 'system');

    await deps.store.markProjection(reg.id, 'ss_org', 'done');
    logger.info({
      operation: op,
      status: 'success',
      registration_id: reg.id,
      aggregator_id: reg.aggregatorId,
      ss_org_id: ssOrgId,
      latency_ms: Date.now() - start,
    });
    return { ok: true };
  } catch (err: unknown) {
    return failSsOrg(op, reg, err instanceof Error ? err.message : 'unknown', deps, start);
  }
}

async function failSsOrg(
  op: string,
  reg: Registration,
  error: string,
  deps: EnsureSignalstackOrgDeps,
  start: number,
): Promise<EnsureResult> {
  logger.error({
    operation: op,
    status: 'failure',
    registration_id: reg.id,
    error,
    latency_ms: Date.now() - start,
  });
  await deps.store.markProjection(reg.id, 'ss_org', 'failed');
  return { ok: false, error };
}
