/**
 * Idempotent executor: ensure the Keycloak identity is in the desired state.
 *
 * For `approved`/`active` registrations: find-or-create the KC user by email,
 * enable them, and set `decision_made = 'approved'` and `aggregator_id`.
 *
 * For `rejected` registrations: find the user and disable them with
 * `decision_made = 'rejected'`.
 *
 * This is the ONLY place a Keycloak user is created in the new FSM flow.
 * Before this runs (at `submitted`/`verified` state), no KC user exists.
 */

import { logger } from '../../logger.js';
import { KC_ATTR } from '../idp-admin/attributes.js';
import type { IdpAdminAdapter } from '../idp-admin/interface.js';
import type { RegistrationStoreBase, Registration } from '../registration-store/interface.js';
import type { EnsureResult } from './index.js';

export interface EnsureKeycloakUserDeps {
  store: RegistrationStoreBase;
  idpAdmin: IdpAdminAdapter;
}

/**
 * Ensures the KC user matches the desired state for an approved registration.
 *
 * Find-or-creates the user by email, enables them, sets `decision_made =
 * 'approved'`, and links their `aggregator_id` attribute to the graduated
 * aggregator row. Idempotent: calling twice is safe.
 *
 * @param reg - Registration in `approved` or `active` state.
 * @param deps - IdP admin adapter and store.
 * @returns ok on success or skip; ok: false on IDP error.
 */
export async function ensureKeycloakUser(
  reg: Registration,
  deps: EnsureKeycloakUserDeps,
): Promise<EnsureResult> {
  const op = 'provisioning.ensureKeycloakUser';
  const start = Date.now();

  if (reg.provisionState.kc_user === 'done') {
    logger.debug({
      operation: op,
      status: 'skipped',
      registration_id: reg.id,
      reason: 'already_done',
    });
    return { ok: true };
  }

  try {
    // Resolve or create the KC user, keyed by email.
    let userId = reg.idpUserId ?? null;

    if (!userId) {
      const findResult = await deps.idpAdmin.findByEmail(reg.contactEmail);
      if (!findResult.ok) {
        return fail(op, reg.id, findResult.error.message, deps, start);
      }

      if (findResult.value) {
        userId = findResult.value.id;
      } else {
        const createResult = await deps.idpAdmin.createUser({
          email: reg.contactEmail,
          phone: reg.contactPhone,
          enabled: false, // enableUser called next, after attributes are set
          attributes: {
            [KC_ATTR.PHONE_NUMBER]: reg.contactPhone,
            [KC_ATTR.DECISION_MADE]: 'pending',
          },
          requiredActions: ['UPDATE_PROFILE'],
        });
        if (!createResult.ok) {
          if (createResult.error.code === 'USER_EXISTS') {
            // Concurrent create — re-fetch
            const reFind = await deps.idpAdmin.findByEmail(reg.contactEmail);
            if (!reFind.ok || !reFind.value) {
              return fail(op, reg.id, 'concurrent create then not found', deps, start);
            }
            userId = reFind.value.id;
          } else {
            return fail(op, reg.id, createResult.error.message, deps, start);
          }
        } else {
          userId = createResult.value.id;
        }
      }
    }

    // Set the approved decision + aggregator_id attribute.
    const attrs: Record<string, string | null> = {
      [KC_ATTR.DECISION_MADE]: 'approved',
    };
    if (reg.aggregatorId) {
      attrs[KC_ATTR.AGGREGATOR_ID] = reg.aggregatorId;
      attrs[KC_ATTR.AGGREGATOR_TYPE] = reg.orgType;
    }

    const setAttrResult = await deps.idpAdmin.setAttributes(userId, attrs);
    if (!setAttrResult.ok) {
      return fail(op, reg.id, setAttrResult.error.message, deps, start);
    }

    const enableResult = await deps.idpAdmin.enableUser(userId);
    if (!enableResult.ok) {
      return fail(op, reg.id, enableResult.error.message, deps, start);
    }

    await deps.store.markProjection(reg.id, 'kc_user', 'done');
    logger.info({
      operation: op,
      status: 'success',
      registration_id: reg.id,
      idp_user_id: userId,
      latency_ms: Date.now() - start,
    });
    return { ok: true };
  } catch (err: unknown) {
    return fail(op, reg.id, err instanceof Error ? err.message : 'unknown', deps, start);
  }
}

/**
 * Ensures the KC user is disabled with `decision_made = 'rejected'`.
 *
 * Skips when no KC user exists (no user was ever created — this is fine for
 * registrations rejected before provisioning started) or when already done.
 *
 * @param reg - Registration in `rejected` state.
 * @param deps - IdP admin adapter and store.
 */
export async function ensureKeycloakUserDisabled(
  reg: Registration,
  deps: EnsureKeycloakUserDeps,
): Promise<EnsureResult> {
  const op = 'provisioning.ensureKeycloakUserDisabled';
  const start = Date.now();

  if (reg.provisionState.kc_user === 'done') {
    logger.debug({
      operation: op,
      status: 'skipped',
      registration_id: reg.id,
      reason: 'already_done',
    });
    return { ok: true };
  }

  try {
    const userId = reg.idpUserId;
    if (!userId) {
      // No KC user was ever created (rejection before provisioning). Mark done.
      await deps.store.markProjection(reg.id, 'kc_user', 'done');
      return { ok: true };
    }

    const findResult = await deps.idpAdmin.findById(userId);
    if (!findResult.ok) {
      return fail(op, reg.id, findResult.error.message, deps, start);
    }
    if (!findResult.value) {
      // User already deleted — that's fine.
      await deps.store.markProjection(reg.id, 'kc_user', 'done');
      return { ok: true };
    }

    const setAttrResult = await deps.idpAdmin.setAttributes(userId, {
      [KC_ATTR.DECISION_MADE]: 'rejected',
    });
    if (!setAttrResult.ok) {
      return fail(op, reg.id, setAttrResult.error.message, deps, start);
    }

    const disableResult = await deps.idpAdmin.disableUser(userId);
    if (!disableResult.ok) {
      return fail(op, reg.id, disableResult.error.message, deps, start);
    }

    await deps.store.markProjection(reg.id, 'kc_user', 'done');
    logger.info({
      operation: op,
      status: 'success',
      registration_id: reg.id,
      latency_ms: Date.now() - start,
    });
    return { ok: true };
  } catch (err: unknown) {
    return fail(op, reg.id, err instanceof Error ? err.message : 'unknown', deps, start);
  }
}

async function fail(
  op: string,
  registrationId: string,
  error: string,
  deps: EnsureKeycloakUserDeps,
  start: number,
): Promise<EnsureResult> {
  logger.error({
    operation: op,
    status: 'failure',
    registration_id: registrationId,
    error,
    latency_ms: Date.now() - start,
  });
  await deps.store.markProjection(registrationId, 'kc_user', 'failed');
  return { ok: false, error };
}
