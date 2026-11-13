/**
 * Coordinator approval (`@aggregator-dpg/api`).
 *
 * The one place a pending coordinator becomes active, run by invite
 * activation. Approve provisions Signals and Keycloak before its
 * compare-and-set; if that loses, the Keycloak user is disabled and stamped
 * `rejected` again.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';
import { getUserStore, type Coordinator } from '../user-store/index.js';
import { getOrganisationStore } from '../organisation-store/index.js';
import { getIdpAdmin, KC_ATTR, type IdpUser } from '../idp-admin/index.js';
import { getSignalStackWriter } from '../signalstack.js';
import { getNetworkConfig } from '../network-config.js';
import { recordLoginIdentity } from '../identity-store/record.js';
import { requestTokenRolesSync } from '../authz/token-roles.js';

/** The result of an approval. */
export type ApprovalOutcome =
  | { kind: 'approved' }
  | { kind: 'already_decided'; status: AggregatorStatus }
  | { kind: 'not_found' }
  /** The coordinator's org is no longer active. */
  | { kind: 'org_inactive' }
  | { kind: 'unavailable'; dependency: 'signalstack' | 'idp' | 'db' };

/** Inputs of {@link approveCoordinator}. */
export interface CoordinatorApprovalInput {
  aggregatorId: string;
  /** Written to `updated_by`: `invite:<inviter id>`. */
  decidedBy: string;
  requestId?: string;
  log: FastifyBaseLogger;
}

/**
 * Loads a coordinator and its Keycloak user, recording the login link
 * (best effort).
 *
 * @param aggregatorId - Coordinator id.
 * @returns The row and the user, or why they are unavailable.
 */
async function loadCoordinatorAndUser(
  aggregatorId: string,
): Promise<
  | { ok: true; aggregator: Coordinator; kcUser: IdpUser }
  | { ok: false; reason: 'not_found' | 'db' | 'idp' | 'idp_missing' }
> {
  const stored = await getUserStore().findById(aggregatorId);
  if (!stored.ok) return { ok: false, reason: 'db' };
  if (!stored.value) return { ok: false, reason: 'not_found' };
  const kc = await getIdpAdmin().findByAttribute(KC_ATTR.AGGREGATOR_ID, aggregatorId);
  if (!kc.ok) return { ok: false, reason: 'idp' };
  if (!kc.value) return { ok: false, reason: 'idp_missing' };
  await recordLoginIdentity(aggregatorId, kc.value.id, 'decisions.recordIdentity');
  return { ok: true, aggregator: stored.value, kcUser: kc.value };
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
    aggregator_id: input.aggregatorId,
  });
  const lookup = await loadCoordinatorAndUser(input.aggregatorId);
  if (!lookup.ok) {
    if (lookup.reason === 'not_found' || lookup.reason === 'idp_missing')
      return { kind: 'not_found' };
    return { kind: 'unavailable', dependency: lookup.reason === 'db' ? 'db' : 'idp' };
  }
  if (lookup.aggregator.status !== 'pending') {
    return { kind: 'already_decided', status: lookup.aggregator.status };
  }
  return approve(input, lookup.aggregator, lookup.kcUser, log);
}

async function approve( // NOSONAR typescript:S3776 — inherently branchy decision flow; splitting would obscure it
  input: CoordinatorApprovalInput,
  aggregator: Coordinator,
  kcUser: IdpUser,
  log: FastifyBaseLogger,
): Promise<ApprovalOutcome> {
  const store = getUserStore();
  const idp = getIdpAdmin();

  // The coordinator's org must still be active.
  if (aggregator.parentOrgId) {
    const org = await getOrganisationStore().findById(aggregator.parentOrgId);
    if (!org.ok) return { kind: 'unavailable', dependency: 'db' };
    if (org.value?.status !== 'active') return { kind: 'org_inactive' };
  }

  // 1. Signals first. Until it succeeds the row stays pending; a retry is safe
  //    (idempotent on external_id).
  const signalstack = getSignalStackWriter();
  let signalstackOrgId: string | null = null;
  if (signalstack) {
    const started = Date.now();
    const networkCfg = await getNetworkConfig();
    // The coordinator's known domains; none (or `[]`) means all of them.
    const served = aggregator.serves.filter((d) => networkCfg.domainIds.includes(d));
    const domains = served.length > 0 ? served : networkCfg.domainIds;
    const upsert = await signalstack.upsertAggregator({
      external_id: aggregator.id,
      name: aggregator.name,
      slug: aggregator.orgSlug,
      domains,
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

  // 2. Enable the Keycloak user (idempotent); must succeed to sign in.
  const enable = await idp.enableUser(kcUser.id);
  if (!enable.ok) {
    log.error({ status: 'failure', sub_operation: 'idp.enableUser', code: enable.error.code });
    return { kind: 'unavailable', dependency: 'idp' };
  }
  // 3. The gate attribute. Soft-fail: the enabled flag already admits them, and
  //    the login-time check repairs it.
  const stamp = await idp.setUserDecision(kcUser.id, 'approved');
  if (!stamp.ok) {
    log.warn({ status: 'failure', sub_operation: 'idp.setUserDecision', code: stamp.error.code });
  }
  // 4. Signals org id on Keycloak. Soft-fail: login backfill repairs it.
  //    The row's copy is written after the commit point, so a losing approval
  //    never touches the row.
  if (signalstackOrgId) {
    const attr = await idp.setAttributes(kcUser.id, {
      [KC_ATTR.SIGNALSTACK_ORG_ID]: signalstackOrgId,
    });
    if (!attr.ok)
      log.warn({ status: 'failure', sub_operation: 'idp.setAttributes', code: attr.error.code });
  }

  // 5. The commit point: compare-and-set pending → active.
  const cas = await store.approveFromPending(aggregator.id, input.decidedBy);
  if (!cas.ok || cas.value === null) {
    // Failed or lost. Unless the row is now approved, undo the Keycloak
    // changes, so a user is never enabled while its row is not active.
    const now = await store.findById(aggregator.id);
    const current = now.ok ? now.value : null;
    if (current?.status !== 'active') {
      if (current?.status !== 'inactive') {
        await restoreInvited(kcUser.id, log);
      } else {
        await compensate(kcUser.id, log);
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
