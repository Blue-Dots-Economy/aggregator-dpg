/**
 * The coordinator step of an org-loader apply, in `@aggregator-dpg/api`.
 *
 * Creates, resumes or skips one planned coordinator, approves it through
 * `approveCoordinator` and syncs its token roles.
 */

import { approveCoordinator } from '../services/decisions/coordinator.js';
import { syncTokenRoles } from '../services/authz/token-roles.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import { getUserStore } from '../services/user-store/index.js';
import { isProvisioned } from '../services/provisioned.js';
import {
  createCoordinatorWithLogin,
  ownLocations,
} from '../services/registration/coordinator-create.js';
import { ROLES_SYNC_REASON } from './org-loader-apply-orgs.js';
import {
  APPLY_ERROR,
  failed,
  type ApplyContext,
  type RowResult,
} from './org-loader-apply-shared.js';
import { nameKey, type PlannedCoordinator } from './org-loader-plan-shared.js';

/** Error code for each dependency `approveCoordinator` reports unavailable. */
const UNAVAILABLE_CODE = {
  signalstack: APPLY_ERROR.SIGNALSTACK_UNAVAILABLE,
  idp: APPLY_ERROR.IDP_UNAVAILABLE,
  db: APPLY_ERROR.DB_UNAVAILABLE,
} as const;

/**
 * Applies one planned coordinator.
 *
 * @returns The row result; never throws on a service failure.
 */
export async function applyCoordinator(
  p: PlannedCoordinator,
  ctx: ApplyContext,
): Promise<RowResult> {
  const orgId =
    p.orgRef.kind === 'existing' ? p.orgRef.orgId : ctx.orgIds.get(nameKey(p.orgRef.name));
  if (!orgId) return failed(APPLY_ERROR.ORG_NOT_LOADED);
  if (p.action === 'create') return createCoordinator(p, orgId, ctx, 'created');
  const userId = p.existingUserId;
  if (!userId) return failed(APPLY_ERROR.COORDINATOR_NOT_FOUND);
  if (p.action === 'already_loaded') {
    const signalsOrgId = await signalsOrgIdOf(userId);
    return {
      ok: true,
      outcome: 'already_loaded',
      orgId,
      userId,
      ...(signalsOrgId ? { signalsOrgId } : {}),
    };
  }
  return resumeCoordinator(userId, p, orgId, ctx);
}

/**
 * Approves a pending coordinator left by an earlier run, or recreates it when it has no Keycloak user.
 */
async function resumeCoordinator(
  userId: string,
  p: PlannedCoordinator,
  orgId: string,
  ctx: ApplyContext,
): Promise<RowResult> {
  const users = getUserStore();
  const found = await users.findById(userId);
  if (!found.ok) return failed(APPLY_ERROR.DB_UNAVAILABLE);
  const row = found.value;
  if (!row) return failed(APPLY_ERROR.COORDINATOR_NOT_FOUND);
  if (!isProvisioned(row.createdBy)) return failed(APPLY_ERROR.NOT_PROVISIONED);
  if (row.status !== 'pending') return failed(APPLY_ERROR.COORDINATOR_NOT_PENDING);
  const kc = await getIdpAdmin().findByAttribute(KC_ATTR.AGGREGATOR_ID, userId);
  if (!kc.ok) return failed(APPLY_ERROR.IDP_UNAVAILABLE);
  if (kc.value) return approveCoordinatorRow(userId, orgId, ctx, 'resumed');
  const removed = await users.deleteById(userId);
  if (!removed.ok) return failed(APPLY_ERROR.DB_UNAVAILABLE);
  ctx.log.info(
    {
      operation: 'orgLoader.apply.discardHalfCreatedCoordinator',
      status: 'success',
      aggregator_id: userId,
    },
    'removed a coordinator with no Keycloak user before creating it again',
  );
  return createCoordinator(p, orgId, ctx, 'resumed');
}

/** Creates a coordinator with its Keycloak user, then approves it. */
async function createCoordinator(
  p: PlannedCoordinator,
  orgId: string,
  ctx: ApplyContext,
  outcome: 'created' | 'resumed',
): Promise<RowResult> {
  const locations = ownLocations(p.body);
  if (!locations.ok) return failed(locations.error.code);
  const created = await createCoordinatorWithLogin({
    body: p.body,
    contact: p.contact,
    domains: p.domains,
    orgId,
    createdBy: ctx.decidedBy,
    consent: null,
    inviteId: null,
    locations: locations.value,
    log: ctx.log,
  });
  if (!created.ok) return failed(created.error.code);
  return approveCoordinatorRow(created.value.userId, orgId, ctx, outcome);
}

/** Approves a pending coordinator and syncs its roles. */
async function approveCoordinatorRow(
  userId: string,
  orgId: string,
  ctx: ApplyContext,
  outcome: 'created' | 'resumed',
): Promise<RowResult> {
  const approved = await approveCoordinator({
    aggregatorId: userId,
    decidedBy: ctx.decidedBy,
    log: ctx.log,
  });
  switch (approved.kind) {
    case 'approved':
      break;
    case 'already_decided':
      if (approved.status !== 'active') return failed(APPLY_ERROR.COORDINATOR_NOT_PENDING);
      break;
    case 'not_found':
      return failed(APPLY_ERROR.COORDINATOR_NOT_FOUND);
    case 'org_inactive':
      return failed(APPLY_ERROR.ORG_INACTIVE);
    case 'no_profile_types':
      return failed(APPLY_ERROR.NO_PROFILE_TYPES);
    case 'unavailable':
      return failed(UNAVAILABLE_CODE[approved.dependency]);
  }
  const rolesSync = await syncTokenRoles(userId, ROLES_SYNC_REASON);
  const signalsOrgId = await signalsOrgIdOf(userId);
  return {
    ok: true,
    outcome,
    orgId,
    userId,
    ...(signalsOrgId ? { signalsOrgId } : {}),
    rolesSync,
  };
}

/** The coordinator's Signals org id for the report; `undefined` when unset or unreadable. */
async function signalsOrgIdOf(userId: string): Promise<string | undefined> {
  const found = await getUserStore().findById(userId);
  return (found.ok ? found.value?.signalstackOrgId : null) ?? undefined;
}
