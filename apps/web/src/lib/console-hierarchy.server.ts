/**
 * Server-side reads of the organisation hierarchy for the console (`apps/web`):
 * every organisation under the network, and the choices the network admin
 * has when placing an organisation (its "known as" value and parent).
 *
 * @module apps/web/src/lib/console-hierarchy.server
 */

import type {
  OrgHierarchyResponse,
  OrgSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead } from './console-api.server';
import type { KnownAsChoice, ParentChoice } from '../components/console/OrgEditForm';

/** Organisations read per page, and the most pages read. */
const PAGE = 100;
const MAX_PAGES = 5;

/**
 * Reads organisations below the network, up to the page cap.
 *
 * @param rootId - The network's id.
 * @param status - Only orgs with this status, when given.
 * @returns The organisations, and whether more exist than were read.
 */
export async function readNetworkOrgs(
  rootId: string,
  status?: 'active',
): Promise<{ orgs: OrgSearchResponse['orgs']; more: boolean }> {
  const orgs: OrgSearchResponse['orgs'] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: OrgSearchResponse = await consoleRead<OrgSearchResponse>('/v1/org/search', {
      filter: { descendants_of: rootId, ...(status ? { status } : {}) },
      limit: PAGE,
      ...(cursor ? { cursor } : {}),
    });
    orgs.push(...page.orgs);
    cursor = page.next_cursor;
    if (!cursor) return { orgs, more: false };
  }
  return { orgs, more: true };
}

/**
 * Reads every organisation within the viewer's reach (all of them for the
 * network admin, the owned ones for an owner), up to the page cap.
 *
 * @returns The organisations, any status.
 */
export async function readReachableOrgs(): Promise<OrgSearchResponse['orgs']> {
  const orgs: OrgSearchResponse['orgs'] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: OrgSearchResponse = await consoleRead<OrgSearchResponse>('/v1/org/search', {
      limit: PAGE,
      ...(cursor ? { cursor } : {}),
    });
    orgs.push(...page.orgs);
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  return orgs;
}

/**
 * The network admin's choices when placing an organisation: every configured
 * "known as" value with its level, and every org that can be a parent (the
 * network at level 0, then active orgs other than the Default org).
 *
 * @returns The value and parent choices.
 */
export async function readPlacementChoices(): Promise<{
  knownAs: KnownAsChoice[];
  parents: ParentChoice[];
}> {
  const hierarchy = await consoleRead<OrgHierarchyResponse>('/v1/org/hierarchy');
  const active = await readNetworkOrgs(hierarchy.network.id, 'active');
  return {
    knownAs: hierarchy.levels.flatMap((l) =>
      l.values.map((v) => ({ key: v.key, label: v.label, level: l.level })),
    ),
    parents: [
      { id: hierarchy.network.id, name: hierarchy.network.name, level: 0 },
      ...active.orgs
        .filter((o) => !o.is_default && o.level !== null)
        .map((o) => ({ id: o.id, name: o.name, level: o.level as number })),
    ],
  };
}
