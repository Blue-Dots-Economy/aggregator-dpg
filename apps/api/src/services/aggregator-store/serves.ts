/**
 * The domains a coordinator serves (`users.serves`, migration 0029;
 * `@aggregator-dpg/api` aggregator store). Shared by the Postgres and
 * in-memory stores so both store a registration's domain the same way.
 */

/**
 * The `serves` value for a registration's domain: `null` means every domain,
 * stored as `[]` (D4-9); a domain id is stored as a one-element array. The
 * caller validates the id against the network's domains first, so `serves`
 * only ever holds real domain ids (never a sentinel such as the removed
 * `'both'`).
 *
 * @param type - The domain id from the request (already validated), or null.
 * @returns The domain ids to store.
 */
export function servesOf(type: string | null): string[] {
  return type === null ? [] : [type];
}
