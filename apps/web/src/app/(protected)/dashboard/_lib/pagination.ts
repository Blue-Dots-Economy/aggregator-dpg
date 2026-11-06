/**
 * Page list for the dashboard table footer (`web` app).
 */

/** Gap marker in the page list. */
export const PAGE_GAP = '…';

/** Up to this many pages, every page number is shown. Longer lists collapse with gaps. */
const MAX_PAGE_ENTRIES = 7;

/**
 * Returns the page button list with {@link PAGE_GAP} markers.
 *
 * Up to {@link MAX_PAGE_ENTRIES} pages shows every number. Otherwise shows the
 * first, last, current, and the current page's neighbours.
 *
 * @param current - The current page, 1-based.
 * @param totalPages - Number of pages, at least 1.
 */
export function buildPageList(
  current: number,
  totalPages: number,
): Array<number | typeof PAGE_GAP> {
  if (totalPages <= MAX_PAGE_ENTRIES) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const out: Array<number | typeof PAGE_GAP> = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(totalPages - 1, current + 1);
  if (left > 2) out.push(PAGE_GAP);
  for (let p = left; p <= right; p++) out.push(p);
  if (right < totalPages - 1) out.push(PAGE_GAP);
  out.push(totalPages);
  return out;
}
