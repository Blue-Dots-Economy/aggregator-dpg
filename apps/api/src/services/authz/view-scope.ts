/**
 * Read-only reach below an owner's organisations (`@aggregator-dpg/api`).
 *
 * An owner manages the organisations it owns and views, read-only, every
 * organisation below them. Writes keep the owned reach (`scope.ts`,
 * `manage-scope.ts`); reads of organisations and coordinators use the wider
 * view reach built here.
 */

import { getOrganisationStore } from '../organisation-store/index.js';
import type { OrgStoreResult } from '../organisation-store/index.js';
import { reachableOrgIds } from './scope.js';
import type { Actor } from '../auth/actor/index.js';

/**
 * Adds every organisation below the given ones.
 *
 * @param ids - Organisation ids, or `null` for every organisation (kept as is).
 * @returns The ids and their descendants, or `null`.
 */
export async function withOrgsBelow(
  ids: string[] | null,
): Promise<OrgStoreResult<string[] | null>> {
  if (ids === null || ids.length === 0) return { ok: true, value: ids };
  const below = await getOrganisationStore().descendantIds(ids);
  if (!below.ok) return below;
  return { ok: true, value: [...ids, ...below.value.filter((id) => !ids.includes(id))] };
}

/**
 * The organisations the actor may read: its reach plus every organisation below.
 *
 * @param actor - The resolved actor.
 * @returns The ids, or `null` for every organisation (the network admin).
 */
export async function viewableOrgIds(actor: Actor): Promise<OrgStoreResult<string[] | null>> {
  return withOrgsBelow(reachableOrgIds(actor));
}

/**
 * Whether an organisation is only viewed, not owned: below the actor's own
 * organisations. Contacts there are always masked, and reads are logged as such.
 *
 * @param actor - The resolved actor.
 * @param orgId - The organisation.
 * @returns `true` when the actor does not reach the organisation by ownership.
 */
export function isOnlyViewed(actor: Actor, orgId: string | null): boolean {
  const owned = reachableOrgIds(actor);
  return owned !== null && (orgId === null || !owned.includes(orgId));
}
