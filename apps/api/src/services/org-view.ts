/**
 * Org-level view query (spec §10).
 *
 * Belongs to `@aggregator-dpg/api`. Resolves an org's coordinators purely from
 * the `aggregators.parent_org_id` FK — the single authority for the
 * org→coordinator link (spec A1). No Keycloak calls, no group membership; the
 * future org console builds on this without a data migration.
 */

import { getAggregatorStore } from './aggregator-store/index.js';
import type { Aggregator, StoreResult } from './aggregator-store/index.js';

/**
 * Lists every coordinator belonging to the given org.
 *
 * @param orgId - `aggregator_orgs.id`.
 * @returns The org's coordinators (possibly empty); never throws.
 */
export async function listOrgCoordinators(orgId: string): Promise<StoreResult<Aggregator[]>> {
  return getAggregatorStore().findByParentOrgId(orgId);
}
