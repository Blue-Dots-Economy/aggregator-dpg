/**
 * Reads every row matching the dashboard filters, for "Select all N matching" (`web` app).
 */

/** Largest `limit` the dashboard API and the BFF accept for one read. */
export const DASHBOARD_MAX_LIMIT = 200;

/**
 * Most pages one "Select all" reads (10,000 rows at the maximum limit).
 *
 * Bounds the requests one click can make; a larger set is selected in part.
 */
export const MAX_SELECT_ALL_PAGES = 50;

/** Reads one page of matching items. */
export type PageReader<T> = (page: number, limit: number) => Promise<T[]>;

/** Items read by {@link readAllMatching}. */
export interface MatchingRead<T> {
  items: T[];
  /** True when exactly `total` items were read. */
  complete: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Select all was cancelled', 'AbortError');
}

/**
 * Reads the `total` matching items, one page of at most {@link DASHBOARD_MAX_LIMIT} at a time.
 *
 * Pages are read in order, up to {@link MAX_SELECT_ALL_PAGES}. A short page
 * ends the read, since the set can shrink while it runs. `complete` is false
 * when fewer or more than `total` items came back.
 *
 * @param read - Reads one page.
 * @param total - Number of matching items the caller expects.
 * @param signal - Stops the read between pages when aborted.
 * @returns The items read, in order, and whether they are the whole set.
 * @throws Whatever `read` throws, or an `AbortError` once `signal` is aborted.
 */
export async function readAllMatching<T>(
  read: PageReader<T>,
  total: number,
  signal?: AbortSignal,
): Promise<MatchingRead<T>> {
  if (total <= 0) return { items: [], complete: true };
  const limit = Math.min(total, DASHBOARD_MAX_LIMIT);
  const pages = Math.min(Math.ceil(total / limit), MAX_SELECT_ALL_PAGES);
  const items: T[] = [];
  for (let page = 1; page <= pages; page++) {
    throwIfAborted(signal);
    // Each read depends on the one before: a short page ends the loop.
    const pageItems = await read(page, limit);
    items.push(...pageItems);
    if (pageItems.length < limit) break;
  }
  throwIfAborted(signal);
  return { items, complete: items.length === total };
}
