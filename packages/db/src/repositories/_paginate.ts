/**
 * Shared pagination helper for repository findMany implementations.
 *
 * Builds a Paginated<T> result correctly under exactOptionalPropertyTypes —
 * nextCursor is only set (not assigned undefined) when a next page exists.
 *
 * @module @aggregator-dpg/db/repositories (internal)
 */

import type { Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import { encodeCursor } from './_cursor.js';

/**
 * Builds a Paginated<T> from a page of items.
 *
 * @param items - Items returned from the DB query.
 * @param total - Total row count from the accompanying COUNT query.
 * @param limit - Page size used for the query.
 * @param getId - Extracts the UUID id from an item.
 * @param getDate - Extracts the cursor timestamp (createdAt or occurredAt) from an item.
 */
export function buildPaginated<T>(
  items: T[],
  total: number,
  limit: number,
  getId: (item: T) => string,
  getDate: (item: T) => Date,
): Paginated<T> {
  const result: Paginated<T> = { items, total };
  if (items.length === limit && items.length > 0) {
    const last = items[items.length - 1]!;
    result.nextCursor = { value: encodeCursor(getId(last), getDate(last)) };
  }
  return result;
}

/**
 * Resolves the effective page limit from paging options.
 *
 * @param paging - Caller-supplied paging options.
 * @param defaultLimit - Fallback when paging.limit is absent.
 * @param maxLimit - Hard ceiling regardless of what the caller requests.
 */
export function resolveLimit(paging?: Paging, defaultLimit = 20, maxLimit = 100): number {
  return Math.min(paging?.limit ?? defaultLimit, maxLimit);
}
