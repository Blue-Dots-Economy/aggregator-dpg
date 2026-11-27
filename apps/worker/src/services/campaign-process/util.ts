/**
 * Small helpers shared by the campaign channel handlers in
 * `@aggregator-dpg/worker`.
 */

/**
 * Truncates an error reason to 500 characters.
 */
export function truncateReason(reason: string): string {
  return reason.length > 500 ? `${reason.slice(0, 497)}...` : reason;
}

/**
 * Splits an array into chunks of `size`; the last chunk may be shorter.
 */
export function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
