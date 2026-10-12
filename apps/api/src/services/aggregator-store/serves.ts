/**
 * The domains a coordinator serves (`users.serves`, migration 0029;
 * `@aggregator-dpg/api` aggregator store). Shared by the Postgres and
 * in-memory stores so both store a registration's domain the same way.
 */

/**
 * The `serves` value for a registration's domain: `null` and the legacy
 * `'both'` mean every domain, stored as `[]` (D4-9).
 *
 * @param type - The domain id from the request, or null.
 * @returns The domain ids to store.
 */
export function servesOf(type: string | null): string[] {
  return type === null || type === 'both' ? [] : [type];
}
