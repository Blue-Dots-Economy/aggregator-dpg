/**
 * Reach checks for the console routes (`@aggregator-dpg/api`, user & org
 * Phase 5).
 *
 * Reach answers "is this target within the actor's organisations": the
 * network admin reaches everything; an org owner reaches the orgs it owns and
 * their coordinators; nobody else reaches anything. A target out of reach is
 * answered **404**, never 403, so ids cannot be probed (design C7). Whether
 * the actor may use a route at all (403) is decided before this, by the
 * route guard (and later by RBAC's capability check; handoff H-9).
 *
 * Pure functions over a resolved {@link Actor}; no I/O.
 */

import { isNetworkAdmin, ownedOrgIds, type Actor } from '../auth/actor/index.js';

/**
 * The org ids the actor reaches, or `null` for every org (the network admin).
 *
 * @param actor - A resolved admin actor.
 * @returns Owned org ids, or `null` when unrestricted.
 */
export function reachableOrgIds(actor: Actor): string[] | null {
  if (actor.userType !== 'admin') return [];
  return isNetworkAdmin(actor) ? null : ownedOrgIds(actor);
}

/**
 * Whether an org is within the actor's reach.
 *
 * @param actor - A resolved actor.
 * @param orgId - The target org (null never reaches).
 * @returns `true` when reachable.
 */
export function reachesOrg(actor: Actor, orgId: string | null): boolean {
  if (!orgId) return false;
  const ids = reachableOrgIds(actor);
  return ids === null || ids.includes(orgId);
}

/**
 * Narrows a requested org filter to the actor's reach: an out-of-reach
 * `org_id` yields "no orgs" (an empty page), indistinguishable from an org
 * with no matches.
 *
 * @param actor - A resolved admin actor.
 * @param requested - The `org_id` filter, if any.
 * @returns The ids to search, or `null` for every org.
 */
export function scopeOrgFilter(actor: Actor, requested?: string): string[] | null {
  const ids = reachableOrgIds(actor);
  if (requested === undefined) return ids;
  return ids === null || ids.includes(requested) ? [requested] : [];
}
