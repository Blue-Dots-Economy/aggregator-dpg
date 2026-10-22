/**
 * Effective permissions (`@aggregator-dpg/rbac`, design §1 and §3).
 *
 * A user's base roles come from their memberships (decision D7); their
 * additional roles are assigned per organisation. What they may do in an
 * organisation is the union of the permissions of those roles held there or
 * in its ancestors. Pure functions: the API supplies the memberships, the
 * live additional roles and the role catalogue.
 *
 * @module @aggregator-dpg/rbac/permissions
 */

import { NOT_THROUGH_ROOT } from './catalogue.js';
import { compareCodeUnits } from './order.js';
import type {
  BaseFor,
  Capability,
  HeldRole,
  Membership,
  OrgType,
  RoleDefinition,
  UserType,
} from './interface.js';

export type { HeldRole, Membership } from './interface.js';

/** The role catalogue, indexed for lookups. */
export interface RoleIndex {
  byKey: ReadonlyMap<string, RoleDefinition>;
  base: Readonly<Record<BaseFor, RoleDefinition | undefined>>;
}

/**
 * Indexes a role catalogue by key and by base membership.
 *
 * @param roles - Every role (built-in and custom).
 * @returns The index.
 */
export function indexRoles(roles: readonly RoleDefinition[]): RoleIndex {
  const byKey = new Map(roles.map((r) => [r.key, r]));
  const base = (b: BaseFor) => roles.find((r) => r.baseFor === b);
  return {
    byKey,
    base: {
      org_member: base('org_member'),
      org_owner: base('org_owner'),
      root_owner: base('root_owner'),
    },
  };
}

/**
 * The base role a membership implies.
 *
 * @param index - The role catalogue.
 * @param m - The membership.
 * @returns Coordinator for a member, Org Admin for an aggregator owner,
 *   Network Admin for the root's owner; undefined when the catalogue has none.
 */
export function baseRoleOf(index: RoleIndex, m: Membership): RoleDefinition | undefined {
  if (m.relation === 'member') return index.base.org_member;
  return m.orgType === 'network_facilitator' ? index.base.root_owner : index.base.org_owner;
}

/** The facts effective permissions are computed from. */
export interface PermissionSubject {
  userType: UserType;
  memberships: readonly Membership[];
  held: readonly HeldRole[];
}

/**
 * The permissions a user holds where a question applies.
 *
 * Counts every base role and every unexpired additional role held in one of
 * `orgIds` (the organisation acted on and its ancestors). With `orgIds` null
 * (a route with no single target) it counts them in every organisation the
 * user belongs to or owns. A role for another account type counts for
 * nothing, and the root organisation never contributes personal data.
 *
 * @param index - The role catalogue.
 * @param subject - The user's account type, memberships and additional roles.
 * @param orgIds - The organisation acted on and its ancestors, or null.
 * @param now - Epoch milliseconds, for expiry.
 * @returns The permissions, sorted, without duplicates.
 */
export function effectivePermissions(
  index: RoleIndex,
  subject: PermissionSubject,
  orgIds: ReadonlySet<string> | null,
  now: number,
): Capability[] {
  const orgTypeOf = new Map(subject.memberships.map((m) => [m.orgId, m.orgType]));
  const applies = (orgId: string) => orgIds === null || orgIds.has(orgId);
  const out = new Set<Capability>();
  const add = (role: RoleDefinition | undefined, orgType: OrgType | undefined) => {
    if (!role || !orgType || role.accountType !== subject.userType) return;
    if (!role.assignableOrgTypes.includes(orgType)) return;
    for (const p of role.permissions) {
      if (orgType === 'network_facilitator' && NOT_THROUGH_ROOT.includes(p)) continue;
      out.add(p);
    }
  };
  for (const m of subject.memberships) {
    if (applies(m.orgId)) add(baseRoleOf(index, m), m.orgType);
  }
  for (const h of subject.held) {
    if (!applies(h.orgId)) continue;
    if (h.expiresAt !== null && h.expiresAt <= now) continue;
    add(index.byKey.get(h.roleKey), orgTypeOf.get(h.orgId));
  }
  return [...out].sort(compareCodeUnits);
}
