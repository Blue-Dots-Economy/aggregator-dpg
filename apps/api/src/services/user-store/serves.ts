/**
 * The domains a coordinator serves (`users.serves`) in the `@aggregator-dpg/api`
 * user store. Shared by the Postgres and in-memory stores.
 */

import { servedDomainIds } from '@aggregator-dpg/shared-primitives/aggregator';

/**
 * The `serves` value for a registration's domain.
 *
 * `null` means no profile type and is stored as `[]`; a domain id is stored as
 * a one-element array. The caller validates the id first.
 *
 * @param type - The domain id from the request (already validated), or null.
 * @returns The domain ids to store.
 */
export function servesOf(type: string | null): string[] {
  return type === null ? [] : [type];
}

/**
 * The `serves` value for a new coordinator.
 *
 * Uses `serves` when given, without repeats, else {@link servesOf} of `type`.
 *
 * @param input - The create input's `type` and optional `serves`.
 * @returns The domain ids to store.
 */
export function servesForCreate(input: {
  type: string | null;
  serves?: readonly string[] | undefined;
}): string[] {
  return input.serves !== undefined ? [...new Set(input.serves)] : servesOf(input.type);
}

/**
 * The network domains a coordinator serves, in network order. Ids not in the
 * network are dropped; an empty `serves` serves nothing.
 *
 * @param serves - The coordinator's stored domain ids.
 * @param domainIds - The active network's domain ids, in declaration order.
 * @returns The served domain ids.
 */
export function servedDomains(serves: readonly string[], domainIds: readonly string[]): string[] {
  return servedDomainIds(serves, domainIds);
}
