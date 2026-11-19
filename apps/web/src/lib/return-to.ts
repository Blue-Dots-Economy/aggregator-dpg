/**
 * Same-origin return paths for BFF redirects in the aggregator portal web app.
 *
 * @module apps/web/src/lib/return-to
 */

/** Base used only to parse a relative path; the `.invalid` TLD never resolves. */
const PARSE_BASE = 'https://placeholder.invalid';

/**
 * Returns `value` when it is a same-origin path, else `fallback`.
 *
 * Prevents open redirects: rejects `//host`, `/\host`, encoded tricks such as
 * `/%09/host`, full URLs, control characters, and any path listed in `exclude`.
 *
 * @param value - The requested return path, from untrusted input.
 * @param fallback - The path to use when `value` is absent or unsafe.
 * @param exclude - Paths that must never be returned to, matched without the query.
 * @returns A path with its query and hash.
 */
export function safeReturnPath(
  value: string | null | undefined,
  fallback: string,
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
