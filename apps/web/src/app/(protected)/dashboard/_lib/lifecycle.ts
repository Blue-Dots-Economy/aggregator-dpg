/**
 * Lifecycle filter values for the dashboard table (`web` app).
 *
 * The filter lives in the `?lifecycle=` URL param and narrows the list on the
 * server and the rows on the client.
 */
import type { LifecycleFilter } from '@/services/dashboard.service';
import type { LifecycleStatus } from '@/types';

/**
 * Lifecycle dropdown values.
 *
 * `'all'` means no filter; the others map to {@link LifecycleFilter} on the items endpoint.
 */
export type LifecycleFilterValue = 'all' | LifecycleFilter;

/**
 * Lifecycle values the dropdown offers: `draft` (<100% complete) and `live` (100%).
 *
 * A new value needs an entry here, a dropdown `<option>`, and a `filters.lifecycle_<x>` key.
 */
export const LIFECYCLE_FILTER_VALUES: readonly LifecycleFilterValue[] = ['all', 'draft', 'live'];

/**
 * Checks that a string is one of {@link LIFECYCLE_FILTER_VALUES}.
 *
 * @param raw - Untrusted value, from the URL or a `<select>`.
 */
export function isLifecycleFilterValue(raw: string): raw is LifecycleFilterValue {
  return LIFECYCLE_FILTER_VALUES.some((v) => v === raw);
}

/**
 * Parses `?lifecycle=` from search params.
 *
 * @param raw - The param value, or `null` when absent.
 * @returns The filter value; unknown values resolve to `'all'`.
 */
export function parseLifecycleParam(raw: string | null): LifecycleFilterValue {
  if (!raw) return 'all';
  return isLifecycleFilterValue(raw) ? raw : 'all';
}

/**
 * Returns the `lifecycle` part of a dashboard query for a filter value.
 *
 * @param filter - The active filter.
 * @returns `{ lifecycle }` for `draft` and `live`, else an empty object.
 */
export function lifecycleQuery(filter: LifecycleFilterValue): { lifecycle?: 'draft' | 'live' } {
  return filter === 'draft' || filter === 'live' ? { lifecycle: filter } : {};
}

/**
 * Filters table rows to the selected lifecycle.
 *
 * @param rows - Mapped table rows.
 * @param filter - The active filter; `'all'` returns every row.
 * @returns The matching rows. Rows without `lifecycle_status` count as `'live'`.
 */
export function filterRowsByLifecycle<R extends { lifecycle_status?: LifecycleStatus }>(
  rows: R[],
  filter: LifecycleFilterValue,
): R[] {
  if (filter === 'all') return rows;
  return rows.filter((r) => (r.lifecycle_status ?? 'live') === filter);
}
