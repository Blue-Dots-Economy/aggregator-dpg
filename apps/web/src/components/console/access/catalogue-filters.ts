/**
 * Pure helpers for the network admin's roles and permissions catalogue:
 * search matching, grouping by area and grouping by where a role is held.
 *
 * @module apps/web/src/components/console/access/catalogue-filters
 */

import type { CatalogueRole } from '@aggregator-dpg/shared-primitives/user-org';

/** Which view is on show. */
export type AccessTab = 'roles' | 'permissions' | 'matrix';

/** Where a role is held: the network organisation, or aggregator organisations. */
export type Scope = 'network' | 'aggregator';

/**
 * Lower-cased substring match; an empty query matches everything.
 *
 * @param query - The search text, already trimmed and lower-cased.
 */
export const matches = (query: string, ...fields: string[]): boolean =>
  !query || fields.some((f) => f.toLowerCase().includes(query));

/** The area a permission belongs to: the part before the first dot. */
export const areaOf = (key: string): string => key.split('.')[0] ?? key;

/** Where a role is held, for grouping. */
export const scopeOf = (role: CatalogueRole): Scope =>
  role.held_in.includes('network_facilitator') ? 'network' : 'aggregator';

/**
 * Groups items by the area of their permission key, keeping first-seen order.
 *
 * @param items - The items to group.
 * @param keyOf - Reads the permission key from an item.
 */
export function groupByArea<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const areas = new Map<string, T[]>();
  for (const item of items) {
    const area = areaOf(keyOf(item));
    areas.set(area, [...(areas.get(area) ?? []), item]);
  }
  return areas;
}

/** A permission area as a heading: `profiles` becomes "Profiles". */
export function areaLabel(area: string): string {
  return area.charAt(0).toUpperCase() + area.slice(1).replaceAll('_', ' ');
}
