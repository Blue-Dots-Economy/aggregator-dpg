/**
 * Open-redirect guard for `returnTo` values (`@aggregator-dpg/web`).
 *
 * @module apps/web/src/lib/safe-return
 */

/** Base used only to parse a relative `returnTo`; the `.invalid` TLD never resolves. */
const PARSE_BASE = 'https://placeholder.invalid';

/**
 * Returns `value` when it is a same-origin path, else `fallback`.
 *
 * Rejects full URLs, `//host`, `/\host`, encoded tricks such as `/%09/host`,
 * control characters, and any path listed in `exclude`.
 *
 * @param value - The requested return path.
 * @param fallback - Path used when `value` is missing or unsafe.
 * @param exclude - Paths that must never be returned to, matched without the query.
 * @returns The normalised path with its query and hash, or `fallback`.
 */
export function isSafeReturnTo(
  value: string | null | undefined,
  fallback = '/',
  exclude: readonly string[] = [],
): string {
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return fallback;
  }
  try {
    const parsed = new URL(value, PARSE_BASE);
    if (parsed.origin !== PARSE_BASE) return fallback;
    if (/[\x00-\x1f\x7f]/.test(parsed.pathname)) return fallback;
    if (exclude.includes(parsed.pathname)) return fallback;
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return fallback;
  }
}
