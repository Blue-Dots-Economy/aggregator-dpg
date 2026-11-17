/**
 * Role assignment rules (`@aggregator-dpg/api`, RBAC).
 *
 * The roles API calls these after `requireActor()`. Checks, in order: the
 * target is in reach (else not found), the role exists and is not a base role,
 * the target belongs to or owns the organisation, the caller holds the role's
 * `assigned_by` permission there, the target is not the caller, the account
 * and organisation types match, and the expiry is within `max_days`. Every
 * change is audited. Base roles follow membership and are never assigned.
 */

import type { FastifyRequest } from 'fastify';
import type { Membership, OrgType, RoleDefinition, UserType } from '@aggregator-dpg/rbac';
import { baseRoleOf } from '@aggregator-dpg/rbac';
import { INVITE_DEFAULT_ROLE_KEYS } from '@aggregator-dpg/shared-primitives/user-org';
import { getUserStore } from '../user-store/index.js';
import { getOrganisationStore } from '../organisation-store/index.js';
import type { Actor } from '../auth/actor/index.js';
import { getRoleStore, type RoleStoreResult, type UserRoleRecord } from '../role-store/index.js';
import { requestTokenRolesSync } from './token-roles.js';
import { actorPermissions, checkCapability, type TargetOrg } from './guard.js';
import { reachesOrg } from './scope.js';
import { getRbacRuntime, type RbacRuntime } from './runtime.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

/** Why a role change did not happen. */
export type RoleFailure =
  | { kind: 'rbac_off' }
  | { kind: 'not_found' }
  | { kind: 'unknown_role' }
  | { kind: 'not_allowed'; reason: RoleRefusal }
  | { kind: 'forbidden'; permission: string }
  | { kind: 'unavailable'; message: string };

/** The rule an assignment broke. */
export type RoleRefusal =
  'base_role' | 'not_member' | 'self' | 'account_type' | 'org_type' | 'days_exceed_max';

/** Result of a rule-checked operation. */
export type RoleOutcome<T> = { ok: true; value: T } | { ok: false; failure: RoleFailure };

/** A user's organisations, as the roles API sees them. */
export interface TargetUser {
  userId: string;
  userType: UserType;
  memberships: Membership[];
}

const fail = <T>(failure: RoleFailure): RoleOutcome<T> => ({ ok: false, failure });
const DAY_MS = 24 * 60 * 60 * 1000;

/** The running RBAC state, or the `rbac_off` failure. */
function runtimeOrFail(): RoleOutcome<RbacRuntime> {
  const rt = getRbacRuntime();
  return rt ? { ok: true, value: rt } : fail({ kind: 'rbac_off' });
}

/** The root organisation's id, every aggregator organisation's ancestor. */
async function rootId(): Promise<RoleOutcome<string | null>> {
  const root = await getOrganisationStore().findRoot();
  if (!root.ok) return fail({ kind: 'unavailable', message: root.error.message });
  return { ok: true, value: root.value?.id ?? null };
}

/**
 * Returns the user and the organisations it belongs to or owns.
 *
 * Answers not found unless at least one organisation is within the actor's
 * reach, so ids cannot be probed.
 *
 * @param actor - The acting admin.
 * @param id - The target user.
 * @returns The target user.
 */
export async function userInReach(actor: Actor, id: string): Promise<RoleOutcome<TargetUser>> {
  const coord = await getUserStore().findById(id);
  if (!coord.ok) return fail({ kind: 'unavailable', message: coord.error.message });
  if (coord.value) {
    const orgId = coord.value.parentOrgId;
    if (!orgId || !reachesOrg(actor, orgId)) return fail({ kind: 'not_found' });
    return {
      ok: true,
      value: {
        userId: id,
        userType: 'coordinator',
        memberships: [{ orgId, orgType: 'aggregator', relation: 'member' }],
      },
    };
  }
  const orgStore = getOrganisationStore();
  const [owned, root] = await Promise.all([orgStore.listOwnedBy(id), orgStore.findRoot()]);
  if (!owned.ok) return fail({ kind: 'unavailable', message: owned.error.message });
  if (!root.ok) return fail({ kind: 'unavailable', message: root.error.message });
  const memberships: Membership[] = owned.value
    .filter((o) => o.status === 'active')
    .map((o) => ({ orgId: o.id, orgType: 'aggregator' as OrgType, relation: 'owner' as const }));
  if (root.value && root.value.ownerUserId === id) {
    memberships.push({ orgId: root.value.id, orgType: 'network_facilitator', relation: 'owner' });
  }
  const reachable = memberships.filter((m) => reachesOrg(actor, m.orgId));
  if (reachable.length === 0) return fail({ kind: 'not_found' });
  return { ok: true, value: { userId: id, userType: 'admin', memberships: reachable } };
}

/** The target organisation for a membership, with the root as ancestor. */
function targetOf(m: Membership, root: string | null): TargetOrg {
  return {
    id: m.orgId,
    orgType: m.orgType,
    ancestorIds: m.orgType === 'aggregator' && root ? [root] : [],
  };
}

/** The role rules that need no request: everything after reach and the caller's permission. */
function ruleRefusal(role: RoleDefinition, user: TargetUser, m: Membership): RoleRefusal | null {
  if (role.accountType !== user.userType) return 'account_type';
  if (!role.assignableOrgTypes.includes(m.orgType)) return 'org_type';
  return null;
}

/** A user's roles and the additional roles the caller may assign. */
export interface UserRoles {
  base: Array<{ roleKey: string; orgId: string }>;
  additional: UserRoleRecord[];
  assignable: Array<{ roleKey: string; orgId: string }>;
}

/**
 * Lists a user's base and additional roles, and the additional roles the
 * caller may assign them.
 *
 * @param actor - The acting admin.
 * @param userId - The target user.
 * @param now - Clock, for expiry.
 * @returns The roles.
 */
export async function listUserRoles(
  actor: Actor,
  userId: string,
  now: Date = new Date(),
): Promise<RoleOutcome<UserRoles>> {
  const rt = runtimeOrFail();
  if (!rt.ok) return rt;
  const user = await userInReach(actor, userId);
  if (!user.ok) return user;
  const root = await rootId();
  if (!root.ok) return root;
  const all = await getRoleStore().listForUser(userId);
  if (!all.ok) return fail({ kind: 'unavailable', message: all.error.message });
  // With custom roles off, held custom roles grant nothing; hide them here too.
  // The rows stay and apply again if the flag is turned on.
  const additional = config.RBAC_CUSTOM_ROLES_ENABLED
    ? all.value
    : all.value.filter((a) => rt.value.roles.byKey.has(a.roleKey));
  const base: UserRoles['base'] = [];
  const assignable: UserRoles['assignable'] = [];
  for (const m of user.value.memberships) {
    const b = baseRoleOf(rt.value.roles, m);
    if (b) base.push({ roleKey: b.key, orgId: m.orgId });
    if (userId === actor.userId) continue;
    const callerHolds = new Set(
      actorPermissions(rt.value.roles, actor, targetOf(m, root.value), now.getTime()),
    );
    for (const role of rt.value.roles.byKey.values()) {
      if (role.baseFor || !role.assignedBy || !callerHolds.has(role.assignedBy)) continue;
      if (ruleRefusal(role, user.value, m) === null) {
        assignable.push({ roleKey: role.key, orgId: m.orgId });
      }
    }
  }
  return { ok: true, value: { base, additional, assignable } };
}

/** What an assignment request asks for. */
export interface AssignRequest {
  roleKey: string;
  orgId: string;
  /** Validity in days; omitted = the role's longest validity, or no expiry. */
  days?: number | undefined;
}

/**
 * Assigns an additional role to a user in an organisation, after every rule.
 *
 * @param req - The request (for the permission check's logger and mode).
 * @param actor - The acting admin.
 * @param userId - The target user.
 * @param input - The role, organisation and validity.
 * @param now - Clock, for the expiry.
 * @returns The new assignment.
 */
export async function assignRole(
  req: FastifyRequest,
  actor: Actor,
  userId: string,
  input: AssignRequest,
  now: Date = new Date(),
): Promise<RoleOutcome<UserRoleRecord>> {
  const rt = runtimeOrFail();
  if (!rt.ok) return rt;
  const user = await userInReach(actor, userId);
  if (!user.ok) return user;
  const role = rt.value.roles.byKey.get(input.roleKey);
  if (!role) return fail({ kind: 'unknown_role' });
  if (role.baseFor || !role.assignedBy) return fail({ kind: 'not_allowed', reason: 'base_role' });
  const m = user.value.memberships.find((x) => x.orgId === input.orgId);
  if (!m) return fail({ kind: 'not_allowed', reason: 'not_member' });

  const root = await rootId();
  if (!root.ok) return root;
  const check = await checkCapability(req, actor, role.assignedBy, {
    target: targetOf(m, root.value),
    now: now.getTime(),
    strict: true,
  });
  if (!check.allowed) return fail({ kind: 'forbidden', permission: role.assignedBy });

  if (userId === actor.userId) return fail({ kind: 'not_allowed', reason: 'self' });
  const refusal = ruleRefusal(role, user.value, m);
  if (refusal) return fail({ kind: 'not_allowed', reason: refusal });

  const days = input.days ?? role.maxDays ?? null;
  if (role.maxDays !== null && days !== null && days > role.maxDays) {
    return fail({ kind: 'not_allowed', reason: 'days_exceed_max' });
  }
  const created = await writeAssignment(
    { userId, roleKey: role.key, orgId: m.orgId, grantedBy: actor.userId, days },
    now,
  );
  if (!created.ok) return fail({ kind: 'unavailable', message: created.error.message });
  requestTokenRolesSync([userId], 'role_assigned');
  return { ok: true, value: created.value };
}

/** One assignment to write, after every rule has been applied. */
interface AssignmentWrite {
  userId: string;
  roleKey: string;
  orgId: string;
  grantedBy: string;
  /** Validity in days; null = no expiry. */
  days: number | null;
  /** Why it was made, for the audit; omitted for an admin's own assignment. */
  reason?: string;
}

/**
 * Writes one assignment and its audit row. Shared by every path that assigns
 * a role, so they compute the expiry and audit the change the same way.
 *
 * @param w - The assignment.
 * @param now - Clock, for the expiry.
 * @returns The new assignment, or the store failure.
 */
async function writeAssignment(
  w: AssignmentWrite,
  now: Date,
): Promise<RoleStoreResult<UserRoleRecord>> {
  const expiresAt = w.days === null ? null : new Date(now.getTime() + w.days * DAY_MS);
  return getRoleStore().assign(
    { userId: w.userId, roleKey: w.roleKey, orgId: w.orgId, grantedBy: w.grantedBy, expiresAt },
    {
      event: 'role.assign',
      actorUserId: w.grantedBy,
      targetUserId: w.userId,
      targetOrgId: w.orgId,
      details: {
        role: w.roleKey,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        ...(w.reason ? { reason: w.reason } : {}),
      },
    },
  );
}

/** Why default roles are granted: at activation, or to fill in missing ones. */
export type DefaultRolesReason = 'invite_default' | 'default_backfill';

/** What {@link grantInviteDefaultRoles} did. */
export interface InviteDefaultRolesOutcome {
  granted: string[];
  /** Already live in the organisation; nothing written. */
  present: string[];
  /** Not granted: unknown, not allowed for this account or organisation type, or a store failure. */
  skipped: string[];
}

/**
 * Gives a coordinator every {@link INVITE_DEFAULT_ROLE_KEYS} role it does not
 * already hold live in its organisation, each for its role's longest validity
 * (no expiry when the role has no limit), audited as granted by the
 * organisation's owner. A role the organisation's type cannot hold is skipped,
 * as `assignRole` would refuse it. Best effort: a failure is logged and
 * skipped, and never fails the caller.
 *
 * @param userId - The coordinator.
 * @param org - The organisation it belongs to.
 * @param grantedBy - The organisation's owner.
 * @param opts - `reason` for the audit (default `invite_default`); `syncToken`
 *   false when the caller syncs the token claim itself; `now` for the expiry.
 * @returns The roles granted, already present and skipped.
 */
export async function grantInviteDefaultRoles(
  userId: string,
  org: { id: string; orgType: OrgType },
  grantedBy: string,
  opts: { reason?: DefaultRolesReason; syncToken?: boolean; now?: Date } = {},
): Promise<InviteDefaultRolesOutcome> {
  const reason = opts.reason ?? 'invite_default';
  const now = opts.now ?? new Date();
  const outcome: InviteDefaultRolesOutcome = { granted: [], present: [], skipped: [] };
  const rt = getRbacRuntime();
  if (!rt) return outcome;
  const live = await getRoleStore().listLive(userId, now);
  if (!live.ok) {
    outcome.skipped.push(...INVITE_DEFAULT_ROLE_KEYS);
  } else {
    const held = new Set(live.value.filter((a) => a.orgId === org.id).map((a) => a.roleKey));
    const membership: Membership = { orgId: org.id, orgType: org.orgType, relation: 'member' };
    const user: TargetUser = { userId, userType: 'coordinator', memberships: [membership] };
    for (const key of INVITE_DEFAULT_ROLE_KEYS) {
      const role = rt.roles.byKey.get(key);
      if (held.has(key)) {
        outcome.present.push(key);
      } else if (!role || role.baseFor || ruleRefusal(role, user, membership) !== null) {
        outcome.skipped.push(key);
      } else {
        const days = role.maxDays;
        const created = await writeAssignment(
          { userId, roleKey: key, orgId: org.id, grantedBy, days, reason },
          now,
        );
        (created.ok ? outcome.granted : outcome.skipped).push(key);
      }
    }
  }
  if (outcome.granted.length > 0 || outcome.skipped.length > 0) {
    logger[outcome.skipped.length > 0 ? 'warn' : 'info']({
      operation: 'rbac.roles.grantInviteDefaults',
      status: outcome.skipped.length > 0 ? 'failure' : 'success',
      user_id: userId,
      reason,
      granted: outcome.granted,
      skipped: outcome.skipped,
    });
  }
  if (outcome.granted.length > 0 && opts.syncToken !== false) {
    requestTokenRolesSync([userId], reason);
  }
  return outcome;
}

/**
 * Revokes a user's live additional role in an organisation, after the same
 * reach and permission checks as assigning it.
 *
 * @param req - The request (for the permission check's logger and mode).
 * @param actor - The acting admin.
 * @param userId - The target user.
 * @param roleKey - The role.
 * @param orgId - The organisation.
 * @returns Whether a live assignment was revoked.
 */
export async function revokeRole(
  req: FastifyRequest,
  actor: Actor,
  userId: string,
  roleKey: string,
  orgId: string,
): Promise<RoleOutcome<boolean>> {
  const rt = runtimeOrFail();
  if (!rt.ok) return rt;
  const user = await userInReach(actor, userId);
  if (!user.ok) return user;
  const role = rt.value.roles.byKey.get(roleKey);
  if (!role) return fail({ kind: 'unknown_role' });
  if (role.baseFor || !role.assignedBy) return fail({ kind: 'not_allowed', reason: 'base_role' });
  const m = user.value.memberships.find((x) => x.orgId === orgId);
  if (!m) return fail({ kind: 'not_allowed', reason: 'not_member' });
  const root = await rootId();
  if (!root.ok) return root;
  const check = await checkCapability(req, actor, role.assignedBy, {
    target: targetOf(m, root.value),
    strict: true,
  });
  if (!check.allowed) return fail({ kind: 'forbidden', permission: role.assignedBy });
  const revoked = await getRoleStore().revoke(userId, roleKey, orgId, actor.userId, {
    event: 'role.revoke',
    actorUserId: actor.userId,
    targetUserId: userId,
    targetOrgId: orgId,
    details: { role: roleKey },
  });
  if (!revoked.ok) return fail({ kind: 'unavailable', message: revoked.error.message });
  if (revoked.value !== null) requestTokenRolesSync([userId], 'role_revoked');
  return { ok: true, value: revoked.value !== null };
}

/**
 * Revokes every additional role a user holds in an organisation they no
 * longer belong to or own. Best effort: a failure is logged. A leftover row
 * grants nothing, since roles count only where the user is a member or owner.
 *
 * @param userId - The user who left.
 * @param orgId - The organisation.
 * @param reason - Why (for the audit): `coordinator_rejected`, `owner_replaced`.
 * @param revokedBy - Who caused it; null for a system change.
 */
export async function revokeRolesOnLeave(
  userId: string,
  orgId: string,
  reason: string,
  revokedBy: string | null = null,
): Promise<void> {
  const res = await getRoleStore().revokeAllInOrg(userId, orgId, revokedBy, {
    event: 'role.revoke_on_leave',
    actorUserId: revokedBy,
    targetUserId: userId,
    targetOrgId: orgId,
    details: { reason },
  });
  if (!res.ok) {
    logger.warn({
      operation: 'rbac.roles.revokeOnLeave',
      status: 'failure',
      error: res.error.code,
      reason,
    });
    return;
  }
  if (res.value > 0) {
    logger.info({
      operation: 'rbac.roles.revokeOnLeave',
      status: 'success',
      revoked: res.value,
      reason,
    });
    requestTokenRolesSync([userId], reason);
  }
}
