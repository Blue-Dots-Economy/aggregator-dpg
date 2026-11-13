/**
 * Org-detail rendering for a coordinator (`@aggregator-dpg/api`).
 *
 * `url`, company and GST number belong to the coordinator's org. Each comes
 * from the org when set, else from `users.legacy_org_details`, else empty.
 * `locations` is the coordinator's own address (`users.locations`, migration
 * 0037), never the org's. Shared by the Postgres and in-memory stores.
 */

import type { BecknLocation } from '@aggregator-dpg/shared-primitives/aggregator';
import type { LegacyOrgDetails } from './interface.js';

/**
 * The org's own detail values: `url` and `gstNumber` are the `website` and
 * `gst_number` keys of `organisations.profile`; `legalName` is a column.
 */
export interface OrgDetailColumns {
  url: string | null;
  legalName: string | null;
  gstNumber: string | null;
}

/** The rendered org details of one coordinator. */
export interface RenderedOrgDetails {
  url: string | null;
  company: string | undefined;
  gstNumber: string | undefined;
}

/** A trimmed, non-empty string, or `undefined`. */
function present(v: string | null | undefined): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * Renders a coordinator's org details from its org, falling back per field to
 * its own values.
 *
 * @param org - The org's columns, or `null` when the org is unknown.
 * @param legacy - The coordinator's `legacy_org_details`, or `null`.
 * @returns The values to put on the domain object.
 */
export function renderOrgDetails(
  org: OrgDetailColumns | null,
  legacy: LegacyOrgDetails | null | undefined,
): RenderedOrgDetails {
  const own = legacy ?? {};
  return {
    url: present(org?.url) ?? present(own.url) ?? null,
    company: present(org?.legalName) ?? present(own.company),
    gstNumber: present(org?.gstNumber) ?? present(own.gstNumber),
  };
}

/**
 * The coordinator's own address: `users.locations`, else the address a
 * Default-org coordinator kept in `legacy_org_details`. Never the org's.
 *
 * @param own - `users.locations`.
 * @param legacy - The coordinator's `legacy_org_details`, or `null`.
 * @returns The locations to put on the domain object; `[]` when none.
 */
export function coordinatorLocations(
  own: BecknLocation[] | null | undefined,
  legacy: LegacyOrgDetails | null | undefined,
): BecknLocation[] {
  if (Array.isArray(own) && own.length > 0) return own;
  return Array.isArray(legacy?.locations) ? legacy.locations : [];
}
