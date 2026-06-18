/**
 * Idempotent executor: ensure the Keycloak identity is in the desired state.
 *
 * For `approved`/`active` registrations: find-or-create the KC user by email,
 * persist the userId immediately, enable them, and set `decision_made =
 * 'approved'` and `aggregator_id`.
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
import { handleProvisionFailure } from './provision-failure.js';
import type { EnsureResult } from './index.js';

export interface EnsureKeycloakUserDeps {
  store: RegistrationStoreBase;
  idpAdmin: IdpAdminAdapter;
  /** Dead-letter threshold; read from `config.REGISTRATION_MAX_PROVISION_ATTEMPTS`. */
  maxAttempts: number;
}

/**
 * Ensures the KC user matches the desired state for an approved registration.
 *
 * Find-or-creates the user by email, persists the Keycloak userId to the DB
 * immediately (before any subsequent IDP calls), enables them, and sets
 * `decision_made = 'approved'` plus `aggregator_id`. Idempotent.
 *
 * @param reg - Registration in `approved` or `active` state.
 * @param deps - IdP admin adapter, store, and dead-letter config.
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
        return handleProvisionFailure(
          op,
          reg,
          'kc_user',
          findResult.error.message,
          deps.store,
          deps.maxAttempts,
          start,
        );
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
              return handleProvisionFailure(
                op,
                reg,
                'kc_user',
                'concurrent create then not found',
                deps.store,
                deps.maxAttempts,
                start,
              );
            }
            userId = reFind.value.id;
          } else {
            return handleProvisionFailure(
              op,
              reg,
              'kc_user',
              createResult.error.message,
              deps.store,
              deps.maxAttempts,
              start,
            );
          }
        } else {
          userId = createResult.value.id;
        }
      }

      // Persist the userId immediately so a crash between here and markProjection
      // does not orphan the KC user — on retry we will find it via idpUserId.
      const persistResult = await deps.store.setIdpUserId(reg.id, userId);
      if (!persistResult.ok) {
        return handleProvisionFailure(
          op,
          reg,
          'kc_user',
          persistResult.error.message,
          deps.store,
          deps.maxAttempts,
          start,
        );
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
      return handleProvisionFailure(
        op,
        reg,
        'kc_user',
        setAttrResult.error.message,
        deps.store,
        deps.maxAttempts,
        start,
      );
    }

    const enableResult = await deps.idpAdmin.enableUser(userId);
    if (!enableResult.ok) {
      return handleProvisionFailure(
        op,
        reg,
        'kc_user',
        enableResult.error.message,
        deps.store,
        deps.maxAttempts,
        start,
      );
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
    return handleProvisionFailure(
      op,
      reg,
      'kc_user',
      err instanceof Error ? err.message : 'unknown',
      deps.store,
      deps.maxAttempts,
      start,
    );
  }
}

/**
 * Ensures the KC user is disabled with `decision_made = 'rejected'`.
 *
 * Skips when no KC user exists (no user was ever created — this is fine for
 * registrations rejected before provisioning started) or when `kc_disabled`
 * is already `done`.
 *
 * @param reg - Registration in `rejected` state.
 * @param deps - IdP admin adapter, store, and dead-letter config.
 */
export async function ensureKeycloakUserDisabled(
  reg: Registration,
  deps: EnsureKeycloakUserDeps,
): Promise<EnsureResult> {
  const op = 'provisioning.ensureKeycloakUserDisabled';
  const start = Date.now();

  if (reg.provisionState.kc_disabled === 'done') {
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
      await deps.store.markProjection(reg.id, 'kc_disabled', 'done');
      return { ok: true };
    }

    const findResult = await deps.idpAdmin.findById(userId);
    if (!findResult.ok) {
      return handleProvisionFailure(
        op,
        reg,
        'kc_disabled',
        findResult.error.message,
        deps.store,
        deps.maxAttempts,
        start,
      );
    }
    if (!findResult.value) {
      // User already deleted — that's fine.
      await deps.store.markProjection(reg.id, 'kc_disabled', 'done');
      return { ok: true };
    }

    const setAttrResult = await deps.idpAdmin.setAttributes(userId, {
      [KC_ATTR.DECISION_MADE]: 'rejected',
    });
    if (!setAttrResult.ok) {
      return handleProvisionFailure(
        op,
        reg,
        'kc_disabled',
        setAttrResult.error.message,
        deps.store,
        deps.maxAttempts,
        start,
      );
    }

    const disableResult = await deps.idpAdmin.disableUser(userId);
    if (!disableResult.ok) {
      return handleProvisionFailure(
        op,
        reg,
        'kc_disabled',
        disableResult.error.message,
        deps.store,
        deps.maxAttempts,
        start,
      );
    }

    await deps.store.markProjection(reg.id, 'kc_disabled', 'done');
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
      'kc_disabled',
      err instanceof Error ? err.message : 'unknown',
      deps.store,
      deps.maxAttempts,
      start,
    );
  }
}
