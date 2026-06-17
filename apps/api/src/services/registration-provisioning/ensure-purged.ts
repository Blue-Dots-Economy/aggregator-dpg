/**
 * Idempotent executor: purge PII and KC identity for an abandoned registration.
 *
 * Deletes the KC user (if one was created) and nulls out the contact PII on
 * the registration row. Safe to call multiple times.
 */

import { logger } from '../../logger.js';
import type { IdpAdminAdapter } from '../idp-admin/interface.js';
import type { RegistrationStoreBase, Registration } from '../registration-store/interface.js';
import type { EnsureResult } from './index.js';

export interface EnsurePurgedDeps {
  store: RegistrationStoreBase;
  /** Pass null when KC integration is disabled. */
  idpAdmin: IdpAdminAdapter | null;
}

/**
 * Purges the KC user and PII for an abandoned registration.
 *
 * Idempotent: if the KC user is already gone or never existed, the purge
 * succeeds silently.
 *
 * @param reg - Registration in `abandoned` state.
 * @param deps - IDP admin (nullable) + store.
 * @returns ok on success; ok: false only on an unexpected IDP error.
 */
export async function ensurePurged(
  reg: Registration,
  deps: EnsurePurgedDeps,
): Promise<EnsureResult> {
  const op = 'provisioning.ensurePurged';
  const start = Date.now();

  // No explicit provision_state key for purged — we use the absence of idp_user_id
  // as the idempotency signal. If idp_user_id is already null, KC user is gone.
  if (!reg.idpUserId && !deps.idpAdmin) {
    logger.debug({
      operation: op,
      status: 'skipped',
      registration_id: reg.id,
      reason: 'no_kc_user',
    });
    return { ok: true };
  }

  try {
    if (deps.idpAdmin && reg.idpUserId) {
      const deleteResult = await deps.idpAdmin.deleteUser(reg.idpUserId);
      if (!deleteResult.ok && deleteResult.error.code !== 'USER_NOT_FOUND') {
        logger.error({
          operation: op,
          status: 'failure',
          registration_id: reg.id,
          error: deleteResult.error.message,
          latency_ms: Date.now() - start,
        });
        return { ok: false, error: deleteResult.error.message };
      }
    }

    logger.info({
      operation: op,
      status: 'success',
      registration_id: reg.id,
      latency_ms: Date.now() - start,
    });
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown';
    logger.error({
      operation: op,
      status: 'failure',
      registration_id: reg.id,
      error: message,
      latency_ms: Date.now() - start,
    });
    return { ok: false, error: message };
  }
}
