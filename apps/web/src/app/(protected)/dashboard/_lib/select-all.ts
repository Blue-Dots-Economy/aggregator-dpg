/**
 * Reads every row matching the dashboard filters, for "Select all N matching" (`web` app).
 */

/** Largest `limit` the dashboard API and the BFF accept for one read. */
export const DASHBOARD_MAX_LIMIT = 200;

/** Reads one page of matching items. */
export type PageReader<T> = (page: number, limit: number) => Promise<T[]>;

/**
 * Reads all `total` matching items, one page of at most {@link DASHBOARD_MAX_LIMIT} at a time.
 *
 * Pages are read in order. A short page ends the read, since the set can shrink while it runs.
 *
 * @param read - Reads one page.
 * @param total - Number of matching items the caller expects.
 * @returns The items of every page, in order.
 * @throws Whatever `read` throws; no partial result is returned.
 */
export async function readAllMatching<T>(read: PageReader<T>, total: number): Promise<T[]> {
  if (total <= 0) return [];
  const limit = Math.min(total, DASHBOARD_MAX_LIMIT);
  const pages = Math.ceil(total / limit);
  const out: T[] = [];
  for (let page = 1; page <= pages; page++) {
    // Each read depends on the one before: a short page ends the loop.
    const items = await read(page, limit);
    out.push(...items);
    if (items.length < limit) break;
  }
  return out;
}
