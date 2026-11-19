/**
 * The org step of an org-loader apply, in `@aggregator-dpg/api`.
 *
 * Creates, resumes or skips one planned org, approves it through `approveOrg`
 * and syncs its owner's token roles.
 */

import { approveOrg, grantOwnerAccess } from '../services/decisions/org.js';
import { syncTokenRoles } from '../services/authz/token-roles.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import type { Organisation } from '../services/organisation-store/interface.js';
import { isProvisioned } from '../services/provisioned.js';
import { createOrgWithOwner } from '../services/registration/org-create.js';
import {
  APPLY_ERROR,
  failed,
  unhandledOutcome,
  type ApplyContext,
  type RowResult,
} from './org-loader-apply-shared.js';
import { nameKey, type PlannedOrg } from './org-loader-plan-shared.js';

/** Reason given to the token-roles sync for loaded accounts. */
export const ROLES_SYNC_REASON = 'provisioned';

/**
 * Applies one planned org.
 *
 * @returns The row result; never throws on a service failure.
 */
export async function applyOrg(p: PlannedOrg, ctx: ApplyContext): Promise<RowResult> {
  if (p.action === 'create') {
    const owner = planOwnerSub(p, ctx);
    if (!owner.ok) return owner.result;
    return createOrg(p, ctx, 'created', owner.sub);
  }
  const orgId = p.existingOrgId;
  if (!orgId) return failed(APPLY_ERROR.ORG_NOT_FOUND);
  if (p.action === 'already_loaded') {
    ctx.orgIds.set(nameKey(p.row.name), orgId);
    const found = await getOrganisationStore().findById(orgId);
    const org = found.ok ? found.value : null;
    if (org) await restampInvitedOwner(org, ctx);
    return {
      ok: true,
      outcome: 'already_loaded',
      orgId,
      ...(org ? { userId: org.ownerUserId } : {}),
    };
  }
  return resumeOrg(p, orgId, ctx);
}

/**
 * Marks the owner of a loaded org approved when an earlier run could not.
 *
 * Runs only for an active provisioned org whose owner is still `invited`.
 * Owner access is granted again (idempotent) and the owner is stamped
 * `approved` only when it is fully granted. Failures are logged, never fail the row.
 */
async function restampInvitedOwner(org: Organisation, ctx: ApplyContext): Promise<void> {
  const sub = org.ownerKcSub;
  if (org.status !== 'active' || !isProvisioned(org.createdBy) || !sub) return;
  const idp = getIdpAdmin();
  const user = await idp.findById(sub);
  if (!user.ok) {
    ctx.log.warn({
      operation: 'orgLoader.apply.restampInvitedOwner',
      sub_operation: 'idp.findById',
      status: 'failure',
      org_id: org.id,
      code: user.error.code,
    });
    return;
  }
  if (!user.value) return;
  if (!user.value.attributes?.[KC_ATTR.DECISION_MADE]?.includes('invited')) return;
  const access = await grantOwnerAccess(org, ctx.log);
  if (access.status === 'granted') await stampOwnerApproved(org.id, sub, ctx);
}

/** Sets the owner's `decision_made` to `approved`; a failure is logged only. */
async function stampOwnerApproved(orgId: string, sub: string, ctx: ApplyContext): Promise<void> {
  const stamp = await getIdpAdmin().setUserDecision(sub, 'approved');
  if (!stamp.ok) {
    ctx.log.warn({
      operation: 'orgLoader.apply.setUserDecision',
      status: 'failure',
      org_id: orgId,
      code: stamp.error.code,
    });
  }
}

/**
 * Approves a pending org left by an earlier run, or recreates it when it was half-created.
 */
async function resumeOrg(p: PlannedOrg, orgId: string, ctx: ApplyContext): Promise<RowResult> {
  const found = await getOrganisationStore().findById(orgId);
  if (!found.ok) return failed(APPLY_ERROR.DB_UNAVAILABLE);
  const org = found.value;
  if (!org) return failed(APPLY_ERROR.ORG_NOT_FOUND);
  if (!isProvisioned(org.createdBy)) return failed(APPLY_ERROR.NOT_PROVISIONED);
  if (org.status !== 'pending') return failed(APPLY_ERROR.ORG_NOT_PENDING);
  if (org.ownerKcSub && org.kcGroupId) {
    ctx.orgIds.set(nameKey(p.row.name), org.id);
    return approveOrgRow(org, ctx, 'resumed');
  }
  const discarded = await discardHalfCreated(org, ctx);
  if (!discarded.ok) return discarded.result;
  // A half-created row's `existing` owner is its own login, kept or removed above.
  if (discarded.ownerSub) return createOrg(p, ctx, 'resumed', discarded.ownerSub);
  if (p.ownerRef.kind !== 'planned') {
    return createOrg(p, ctx, 'resumed', undefined, discarded.removedSub);
  }
  const owner = planOwnerSub(p, ctx);
  if (!owner.ok) return owner.result;
  return createOrg(p, ctx, 'resumed', owner.sub);
}

/**
 * Removes a half-created org: the group and owner user linked to it by id, then the row.
 *
 * The owner user stays when the owner is shared with another org or account.
 *
 * @returns The owner's Keycloak user to reuse when recreating, if one is known, and the one removed, if any.
 */
async function discardHalfCreated(
  org: Organisation,
  ctx: ApplyContext,
): Promise<
  | { ok: true; ownerSub: string | undefined; removedSub: string | undefined }
  | { ok: false; result: RowResult }
> {
  const store = getOrganisationStore();
  const idp = getIdpAdmin();
  const fail = (code: string) => ({ ok: false as const, result: failed(code) });
  if (org.kcGroupId) {
    const g = await idp.deleteGroup(org.kcGroupId);
    if (!g.ok) return fail(APPLY_ERROR.IDP_UNAVAILABLE);
  }
  let ownerSub: string | undefined;
  let removedSub: string | undefined;
  if (org.ownerKcSub) {
    const shared = await store.ownerIsShared(org.id);
    if (!shared.ok) return fail(APPLY_ERROR.DB_UNAVAILABLE);
    if (shared.value) {
      ownerSub = org.ownerKcSub;
    } else {
      const u = await idp.deleteUser(org.ownerKcSub);
      if (!u.ok && u.error.code !== 'USER_NOT_FOUND') return fail(APPLY_ERROR.IDP_UNAVAILABLE);
      removedSub = org.ownerKcSub;
    }
  }
  if (!ownerSub) {
    const owned = await store.listOwnedBy(org.ownerUserId);
    if (!owned.ok) return fail(APPLY_ERROR.DB_UNAVAILABLE);
    const others = owned.value.filter((o) => o.id !== org.id && o.ownerKcSub);
    ownerSub = (others.find((o) => o.status === 'active') ?? others[0])?.ownerKcSub ?? undefined;
  }
  const d = await store.deleteById(org.id);
  if (!d.ok) return fail(APPLY_ERROR.DB_UNAVAILABLE);
  ctx.log.info(
    {
      operation: 'orgLoader.apply.discardHalfCreatedOrg',
      status: 'success',
      org_id: org.id,
      group_removed: org.kcGroupId !== null,
      owner_login_kept: ownerSub !== undefined,
    },
    'removed a half-created org before creating it again',
  );
  return { ok: true, ownerSub, removedSub };
}

/**
 * The Keycloak user the plan names for the org's owner: its own, or the one created for an earlier row.
 *
 * @returns The user id, `undefined` for a new owner, or OWNER_LOGIN_MISSING.
 */
function planOwnerSub(
  p: PlannedOrg,
  ctx: ApplyContext,
): { ok: true; sub: string | undefined } | { ok: false; result: RowResult } {
  if (p.ownerRef.kind === 'existing') {
    return { ok: true, sub: ctx.replacedSubs.get(p.ownerRef.kcSub) ?? p.ownerRef.kcSub };
  }
  if (p.ownerRef.kind === 'new') return { ok: true, sub: undefined };
  const sub = ctx.ownerSubs.get(p.ownerRef.line);
  return sub ? { ok: true, sub } : { ok: false, result: failed(APPLY_ERROR.OWNER_LOGIN_MISSING) };
}

/**
 * Creates an org with its owner, then approves it.
 *
 * @param ownerSub - The owner's Keycloak user to reuse; `undefined` creates one.
 * @param replacesSub - A removed owner login that the created one replaces for later rows.
 */
async function createOrg(
  p: PlannedOrg,
  ctx: ApplyContext,
  outcome: 'created' | 'resumed',
  ownerSub: string | undefined,
  replacesSub?: string,
): Promise<RowResult> {
  let parentId: string | undefined;
  if (p.parentRef.kind === 'existing') parentId = p.parentRef.orgId;
  if (p.parentRef.kind === 'planned') {
    parentId = ctx.orgIds.get(nameKey(p.parentRef.name));
    if (!parentId) return failed(APPLY_ERROR.PARENT_NOT_LOADED);
  }
  const created = await createOrgWithOwner({
    form: p.form,
    schemaValues: p.schemaValues,
    phoneE164: p.phoneE164,
    ...(parentId ? { parentId } : {}),
    createdBy: ctx.decidedBy,
    ...(ownerSub ? { existingOwnerKcSub: ownerSub } : {}),
    log: ctx.log,
  });
  if (!created.ok) return failed(created.error.code);
  if (p.ownerRef.kind === 'new') ctx.ownerSubs.set(p.row.line, created.value.ownerKcSub);
  if (replacesSub) ctx.replacedSubs.set(replacesSub, created.value.ownerKcSub);
  ctx.orgIds.set(nameKey(p.row.name), created.value.org.id);
  return approveOrgRow(created.value.org, ctx, outcome);
}

/**
 * Approves a pending org, marks its owner approved when access was fully granted, and syncs the owner's roles.
 */
async function approveOrgRow(
  org: Organisation,
  ctx: ApplyContext,
  outcome: 'created' | 'resumed',
): Promise<RowResult> {
  const approved = await approveOrg({ orgId: org.id, decidedBy: ctx.decidedBy, log: ctx.log });
  switch (approved.kind) {
    case 'approved':
      if (approved.ownerAccess.status === 'granted' && org.ownerKcSub) {
        await stampOwnerApproved(org.id, org.ownerKcSub, ctx);
      }
      break;
    case 'already_decided':
      if (approved.status !== 'active') return failed(APPLY_ERROR.ORG_NOT_PENDING);
      break;
    case 'not_found':
      return failed(APPLY_ERROR.ORG_NOT_FOUND);
    case 'unavailable':
      return failed(APPLY_ERROR.DB_UNAVAILABLE);
    default:
      return unhandledOutcome(approved);
  }
  const rolesSync = await syncTokenRoles(org.ownerUserId, ROLES_SYNC_REASON);
  return { ok: true, outcome, orgId: org.id, userId: org.ownerUserId, rolesSync };
}
