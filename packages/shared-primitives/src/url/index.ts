/**
 * URL string helpers shared across every aggregator process.
 *
 * @module @aggregator-dpg/shared-primitives
 */

/**
 * Removes every trailing `/` from a URL-ish string.
 *
 * Deliberately a loop rather than `replace(/\/+$/, '')`: the regex form has
 * super-linear (polynomial) backtracking because the engine retries the greedy
 * `\/+` from each start offset, which SonarCloud flags as a denial-of-service
 * risk on long inputs (typescript:S8786). This scan is linear and allocates at
 * most one slice.
 *
 * @param value - The string to trim, e.g. a configured base or issuer URL.
 * @returns `value` with all trailing slashes removed; `''` if it was all slashes.
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') end -= 1;
  return end === value.length ? value : value.slice(0, end);
}
