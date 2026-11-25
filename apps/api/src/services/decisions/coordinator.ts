/**
 * Coordinator approval (`@aggregator-dpg/api`).
 *
 * The one place a pending coordinator becomes active, run by invite
 * activation and by an owner's self-add. Approve provisions Signals and
 * Keycloak before its compare-and-set; if that loses, the Keycloak user is
 * disabled and stamped `rejected` again.
 *
 * A shared login (the coordinator's login also holds an admin account and its
 * Keycloak user has no `user_id`, as the owner self-add leaves it) is
 * never written in Keycloak here: the row's `status`
 * and `signalstack_org_id` are the only record of that account.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';
import { getUserStore, type Coordinator } from '../user-store/index.js';
import { getOrganisationStore } from '../organisation-store/index.js';
import { getIdpAdmin, KC_ATTR } from '../idp-admin/index.js';
import { IDP_PROVIDER } from '../idp-admin/provider.js';
import { getIdentityStore } from '../identity-store/index.js';
import { isSharedLogin } from '../auth/shared-login.js';
import { getSignalStackWriter } from '../signalstack.js';
import { getNetworkConfig } from '../network-config.js';
import { servedDomains } from '../user-store/serves.js';
import { recordLoginIdentity } from '../identity-store/record.js';
import { requestTokenRolesSync } from '../authz/token-roles.js';

/** The result of an approval. */
export type ApprovalOutcome =
  | { kind: 'approved' }
  | { kind: 'already_decided'; status: AggregatorStatus }
  | { kind: 'not_found' }
  /** The coordinator's org is no longer active. */
  | { kind: 'org_inactive' }
  /** The coordinator serves no profile type of the network (approve only). */
  | { kind: 'no_profile_types' }
  | { kind: 'unavailable'; dependency: 'signalstack' | 'idp' | 'db' };

/** Inputs of {@link approveCoordinator}. */
export interface CoordinatorApprovalInput {
  userId: string;
  /** Written to `updated_by`: `invite:<inviter id>`, or the owner's admin id for a self-add. */
  decidedBy: string;
  requestId?: string;
  log: FastifyBaseLogger;
}

/**
 * Loads a coordinator and its Keycloak user id: the recorded login first,
 * else the user carrying its `user_id` (whose login is then recorded,
 * best effort).
 *
 * @param userId - Coordinator id.
 * @returns The row and the Keycloak user id, or why they are unavailable.
 */
async function loadCoordinatorAndUser(
  userId: string,
): Promise<
  | { ok: true; aggregator: Coordinator; kcUserId: string }
  | { ok: false; reason: 'not_found' | 'db' | 'idp' | 'idp_missing' }
> {
  const stored = await getUserStore().findById(userId);
  if (!stored.ok) return { ok: false, reason: 'db' };
  if (!stored.value) return { ok: false, reason: 'not_found' };
  const linked = await getIdentityStore().subjectOf(userId, IDP_PROVIDER);
  if (!linked.ok) return { ok: false, reason: 'db' };
  if (linked.value) return { ok: true, aggregator: stored.value, kcUserId: linked.value };
  const kc = await getIdpAdmin().findByAttribute(KC_ATTR.USER_ID, userId);
  if (!kc.ok) return { ok: false, reason: 'idp' };
  if (!kc.value) return { ok: false, reason: 'idp_missing' };
  await recordLoginIdentity(userId, kc.value.id, 'decisions.recordIdentity');
  return { ok: true, aggregator: stored.value, kcUserId: kc.value.id };
}

/**
 * Approves a pending coordinator.
 *
 * @param input - The coordinator and who approves it.
 * @returns The outcome; never throws.
 */
export async function approveCoordinator(
  input: CoordinatorApprovalInput,
): Promise<ApprovalOutcome> {
  const log = input.log.child({
    operation: 'coordinator-approval',
    aggregator_id: input.userId,
  });
  const lookup = await loadCoordinatorAndUser(input.userId);
  if (!lookup.ok) {
    if (lookup.reason === 'not_found' || lookup.reason === 'idp_missing')
      return { kind: 'not_found' };
    return { kind: 'unavailable', dependency: lookup.reason === 'db' ? 'db' : 'idp' };
  }
  if (lookup.aggregator.status !== 'pending') {
    return { kind: 'already_decided', status: lookup.aggregator.status };
  }
  return approve(input, lookup.aggregator, lookup.kcUserId, log);
}

async function approve( // NOSONAR typescript:S3776 — inherently branchy decision flow; splitting would obscure it
  input: CoordinatorApprovalInput,
  aggregator: Coordinator,
  kcUserId: string,
  log: FastifyBaseLogger,
): Promise<ApprovalOutcome> {
  const store = getUserStore();
  const idp = getIdpAdmin();

  // An owner's shared login (an admin account, no `user_id`): no
  // Keycloak write below may touch it.
  const accounts = await getIdentityStore().accountsOf(IDP_PROVIDER, kcUserId);
  if (!accounts.ok) return { kind: 'unavailable', dependency: 'db' };
  const shared = await isSharedLogin(kcUserId, accounts.value);
  if (!shared.ok) return { kind: 'unavailable', dependency: 'idp' };
  const sharedLogin = shared.value;

  // The coordinator's org must still be active.
  if (aggregator.parentOrgId) {
    const org = await getOrganisationStore().findById(aggregator.parentOrgId);
    if (!org.ok) return { kind: 'unavailable', dependency: 'db' };
    if (org.value?.status !== 'active') return { kind: 'org_inactive' };
  }

  // A coordinator with no profile type in the network could act on nothing,
  // so it is not approved until an owner sets its types.
  const networkCfg = await getNetworkConfig();
  const served = servedDomains(aggregator.serves, networkCfg.domainIds);
  if (served.length === 0) {
    log.info({ status: 'skipped', reason: 'no_profile_types' });
    return { kind: 'no_profile_types' };
  }

  // 1. Signals first. Until it succeeds the row stays pending; a retry is safe
  //    (idempotent on external_id).
  const signalstack = getSignalStackWriter();
  let signalstackOrgId: string | null = null;
  if (signalstack) {
    const started = Date.now();
    const upsert = await signalstack.upsertAggregator({
      external_id: aggregator.id,
      name: aggregator.name,
      slug: aggregator.orgSlug,
      domains: served,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
    if (!upsert.success) {
      log.error({
        status: 'failure',
        sub_operation: 'signalstack.upsertAggregator',
        code: upsert.error.code,
        latency_ms: Date.now() - started,
      });
      return { kind: 'unavailable', dependency: 'signalstack' };
    }
    signalstackOrgId = upsert.value.org_id;
  }

  if (sharedLogin) {
    log.info({ status: 'skipped', sub_operation: 'idp.provision', reason: 'shared_login' });
  } else {
    // 2. Enable the Keycloak user (idempotent); must succeed to sign in.
    const enable = await idp.enableUser(kcUserId);
    if (!enable.ok) {
      log.error({ status: 'failure', sub_operation: 'idp.enableUser', code: enable.error.code });
      return { kind: 'unavailable', dependency: 'idp' };
    }
    // 3. The gate attribute. Soft-fail: the enabled flag already admits them, and
    //    the login-time check repairs it.
    const stamp = await idp.setUserDecision(kcUserId, 'approved');
    if (!stamp.ok) {
      log.warn({ status: 'failure', sub_operation: 'idp.setUserDecision', code: stamp.error.code });
    }
    // 4. Signals org id on Keycloak. Soft-fail: login backfill repairs it.
    //    The row's copy is written after the commit point, so a losing approval
    //    never touches the row.
    if (signalstackOrgId) {
      const attr = await idp.setAttributes(kcUserId, {
        [KC_ATTR.SIGNALSTACK_ORG_ID]: signalstackOrgId,
      });
      if (!attr.ok)
        log.warn({ status: 'failure', sub_operation: 'idp.setAttributes', code: attr.error.code });
    }
  }

  // 5. The commit point: compare-and-set pending → active.
  const cas = await store.approveFromPending(aggregator.id, input.decidedBy);
  if (!cas.ok || cas.value === null) {
    // Failed or lost. Unless the row is now approved, undo the Keycloak
    // changes, so a user is never enabled while its row is not active.
    const now = await store.findById(aggregator.id);
    const current = now.ok ? now.value : null;
    if (current?.status !== 'active' && !sharedLogin) {
      if (current?.status !== 'inactive') {
        await restoreInvited(kcUserId, log);
      } else {
        await compensate(kcUserId, log);
      }
    }
    if (signalstackOrgId) {
      // The Signals org stays; a later approval reuses it.
      log.warn({ status: 'skipped', sub_operation: 'signalstack.orgLeftByLostApproval' });
    }
    if (!cas.ok) {
      log.error({
        status: 'failure',
        sub_operation: 'store.approveFromPending',
        code: cas.error.code,
      });
      return { kind: 'unavailable', dependency: 'db' };
    }
    if (!current) return { kind: 'not_found' };
    return { kind: 'already_decided', status: current.status };
  }
  // RBAC edge: the coordinator now holds its base role; refresh its token claim.
  requestTokenRolesSync([aggregator.id], 'coordinator_approved');
  if (signalstackOrgId) {
    const db = await store.updateSignalstackOrgId(aggregator.id, signalstackOrgId, input.decidedBy);
    if (!db.ok)
      log.warn({
        status: 'failure',
        sub_operation: 'store.updateSignalstackOrgId',
        code: db.error.code,
      });
  }

  log.info({ status: 'success', decided_by: input.decidedBy });
  return { kind: 'approved' };
}

/** Stamps `invited` again after an invitee's failed activation, leaving the user enabled to retry. */
async function restoreInvited(kcUserId: string, log: FastifyBaseLogger): Promise<void> {
  const back = await getIdpAdmin().setUserDecision(kcUserId, 'invited');
  if (!back.ok) {
    log.error({
      status: 'failure',
      sub_operation: 'compensate.failedActivation',
      code: back.error.code,
    });
  }
}

/** Disables the user and stamps `rejected` again (a lost or failed approval). */
async function compensate(kcUserId: string, log: FastifyBaseLogger): Promise<void> {
  const idp = getIdpAdmin();
  const [disable, back] = await Promise.all([
    idp.disableUser(kcUserId),
    idp.setUserDecision(kcUserId, 'rejected'),
  ]);
  if (!disable.ok || !back.ok) {
    log.error({
      status: 'failure',
      sub_operation: 'compensate.lostApproval',
      disable: disable.ok ? 'ok' : disable.error.code,
      stamp: back.ok ? 'ok' : back.error.code,
    });
  }
}
