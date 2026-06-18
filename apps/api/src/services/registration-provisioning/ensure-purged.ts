/**
 * Idempotent executor: purge PII and KC identity for an abandoned registration.
 *
 * Deletes the KC user (if one was created or findable by email) and redacts
 * the contact PII on the registration row to sentinels. Marks
 * `provisionState.purged = 'done'` atomically with the PII wipe.
 *
 * Safe to call multiple times.
 */

import { logger } from '../../logger.js';
import type { IdpAdminAdapter } from '../idp-admin/interface.js';
import type { RegistrationStoreBase, Registration } from '../registration-store/interface.js';
import { handleProvisionFailure } from './provision-failure.js';
import type { EnsureResult } from './index.js';

export interface EnsurePurgedDeps {
  store: RegistrationStoreBase;
  /** Pass null when KC integration is disabled. */
  idpAdmin: IdpAdminAdapter | null;
  /** Dead-letter threshold; read from `config.REGISTRATION_MAX_PROVISION_ATTEMPTS`. */
  maxAttempts: number;
}

/**
 * Purges the KC user and PII for an abandoned registration.
 *
 * Guards on `provisionState.purged === 'done'` for idempotency. When
 * `reg.idpUserId` is absent but `idpAdmin` is available, falls back to
 * `findByEmail` to catch orphaned KC users created before the userId was
 * persisted. Calls `store.purgePii()` to atomically redact PII and stamp the
 * `purged` provision key.
 *
 * @param reg - Registration in `abandoned` state.
 * @param deps - IDP admin (nullable), store, and dead-letter config.
 * @returns ok on success; ok: false only on an unexpected IDP or store error.
 */
export async function ensurePurged(
  reg: Registration,
  deps: EnsurePurgedDeps,
): Promise<EnsureResult> {
  const op = 'provisioning.ensurePurged';
  const start = Date.now();

  if (reg.provisionState.purged === 'done') {
    logger.debug({
      operation: op,
      status: 'skipped',
      registration_id: reg.id,
      reason: 'already_done',
    });
    return { ok: true };
  }

  try {
    if (deps.idpAdmin) {
      // Resolve the KC user: prefer the stored idpUserId, fall back to findByEmail
      // to handle orphans where the userId was not persisted before a prior crash.
      let userId = reg.idpUserId ?? null;

      if (!userId) {
        const findResult = await deps.idpAdmin.findByEmail(reg.contactEmail);
        if (!findResult.ok) {
          return handleProvisionFailure(
            op,
            reg,
            'purged',
            findResult.error.message,
            deps.store,
            deps.maxAttempts,
            start,
          );
        }
        userId = findResult.value?.id ?? null;
      }

      if (userId) {
        const deleteResult = await deps.idpAdmin.deleteUser(userId);
        if (!deleteResult.ok && deleteResult.error.code !== 'USER_NOT_FOUND') {
          return handleProvisionFailure(
            op,
            reg,
            'purged',
            deleteResult.error.message,
            deps.store,
            deps.maxAttempts,
            start,
          );
        }
      }
    }

    // Redact PII and mark purged atomically. purgePii() writes sentinels for
    // all three NOT NULL contact fields and stamps provision_state.purged='done'.
    const purgeResult = await deps.store.purgePii(reg.id);
    if (!purgeResult.ok) {
      return handleProvisionFailure(
        op,
        reg,
        'purged',
        purgeResult.error.message,
        deps.store,
        deps.maxAttempts,
        start,
      );
    }

    logger.info({
      operation: op,
      status: 'success',
      registration_id: reg.id,
      latency_ms: Date.now() - start,
    });
    return { ok: true };
  } catch (err: unknown) {
    return handleProvisionFailure(
      op,
      reg,
      'purged',
      err instanceof Error ? err.message : 'unknown',
      deps.store,
      deps.maxAttempts,
      start,
    );
  }
}
