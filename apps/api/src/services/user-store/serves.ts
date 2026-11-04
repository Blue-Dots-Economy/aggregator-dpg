/**
 * The domains a coordinator serves (`users.serves`) in the `@aggregator-dpg/api`
 * user store. Shared by the Postgres and in-memory stores.
 */

/**
 * The `serves` value for a registration's domain.
 *
 * `null` means every domain and is stored as `[]`; a domain id is stored as a
 * one-element array. The caller validates the id first.
 *
 * @param type - The domain id from the request (already validated), or null.
 * @returns The domain ids to store.
 */
export function servesOf(type: string | null): string[] {
  return type === null ? [] : [type];
}

/**
 * The network domains a coordinator serves, in network order.
 *
 * An empty `serves` means every domain. Ids that are not in the network are
 * dropped, so the result is always a subset of `domainIds`.
 *
 * @param serves - The coordinator's stored domain ids.
 * @param domainIds - The active network's domain ids, in declaration order.
 * @returns The served domain ids.
 */
export function servedDomains(serves: readonly string[], domainIds: readonly string[]): string[] {
  if (serves.length === 0) return [...domainIds];
  return domainIds.filter((d) => serves.includes(d));
}
