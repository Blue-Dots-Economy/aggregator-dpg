/**
 * Reach checks for the console routes (`@aggregator-dpg/api`).
 *
 * The network admin reaches everything; an org owner reaches the orgs it owns
 * and their coordinators; nobody else reaches anything. Out of reach answers
 * 404, not 403, so ids cannot be probed. Whether the actor may use a route at
 * all (403) is decided earlier by the route guard.
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
 * Narrows a requested org filter to the actor's reach.
 *
 * An out-of-reach `org_id` yields an empty page, same as an org with no matches.
 *
 * @param actor - A resolved admin actor.
 * @param requested - The `org_id` filter, if any.
 * @returns The ids to search, or `null` for every org.
 */
export function scopeOrgFilter(actor: Actor, requested?: string): string[] | null {
  return narrowOrgFilter(reachableOrgIds(actor), requested);
}

/**
 * Narrows a requested org filter to a set of orgs: one outside the set yields
 * "no orgs" (an empty page).
 *
 * @param ids - The allowed org ids, or `null` for every org.
 * @param requested - The `org_id` filter, if any.
 * @returns The ids to search, or `null` for every org.
 */
export function narrowOrgFilter(ids: string[] | null, requested?: string): string[] | null {
  if (requested === undefined) return ids;
  return ids === null || ids.includes(requested) ? [requested] : [];
}
