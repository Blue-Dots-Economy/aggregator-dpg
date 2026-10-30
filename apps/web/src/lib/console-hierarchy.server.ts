/**
 * Server-side reads of the organisation hierarchy for the console (`apps/web`):
 * every organisation under the network, or within the viewer's reach.
 *
 * @module apps/web/src/lib/console-hierarchy.server
 */

import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead } from './console-api.server';

/** Organisations read per page, and the most pages read. */
const PAGE = 100;
const MAX_PAGES = 5;

/**
 * Reads organisations below the network, up to the page cap.
 *
 * @param rootId - The network's id.
 * @returns The organisations, and whether more exist than were read.
 */
export async function readNetworkOrgs(
  rootId: string,
): Promise<{ orgs: OrgSearchResponse['orgs']; more: boolean }> {
  const orgs: OrgSearchResponse['orgs'] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: OrgSearchResponse = await consoleRead<OrgSearchResponse>('/v1/org/search', {
      filter: { descendants_of: rootId },
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
 * Reads every organisation within the viewer's reach, up to the page cap.
 * The network admin gets all of them; an owner gets its own and every one
 * below them.
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
