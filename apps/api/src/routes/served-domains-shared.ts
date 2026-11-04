/**
 * Domain checks shared by the coordinator routes in `@aggregator-dpg/api`.
 *
 * The coordinator's stored domains (`users.serves`, empty = every domain) decide
 * which domains a request may act on. The token's `aggregator_type` value is
 * not read: it is written once at registration and is not kept in sync.
 */

import { httpError } from '../errors/http-error.js';
import type { AuthContext } from '../services/auth/access-token.js';
import { getNetworkConfig } from '../services/network-config.js';
import { getUserStore, type Coordinator } from '../services/user-store/index.js';
import { servedDomains } from '../services/user-store/serves.js';

/**
 * Loads the calling coordinator's row.
 *
 * @param auth - The verified caller.
 * @returns The coordinator.
 * @throws DB_UNAVAILABLE if the store read fails or the row is missing.
 */
export async function loadCallingCoordinator(auth: AuthContext): Promise<Coordinator> {
  const found = await getUserStore().findById(auth.aggregatorId);
  if (!found.ok || !found.value) {
    throw httpError('DB_UNAVAILABLE', {
      fields: { sub_operation: 'userStore.findById' },
      cause: new Error(found.ok ? 'aggregator row missing for caller' : found.error.code),
    });
  }
  return found.value;
}

/**
 * Resolves the domain a request acts on for a coordinator.
 *
 * Returns `requested` when the coordinator serves it, or the first served
 * domain (network order) when nothing was requested. The caller validates that
 * `requested` is a network domain first.
 *
 * @param coordinator - The calling coordinator.
 * @param requested - The domain named by the request, if any.
 * @returns The domain id to act on.
 * @throws DOMAIN_NOT_SERVED if the domain is not served, or nothing is served.
 */
export async function resolveServedDomain(
  coordinator: Coordinator,
  requested: string | undefined,
): Promise<string> {
  const networkCfg = await getNetworkConfig();
  const served = servedDomains(coordinator.serves, networkCfg.domainIds);
  const domain = requested ?? served[0];
  if (!domain || !served.includes(domain)) {
    throw httpError('DOMAIN_NOT_SERVED', {
      fields: { requested_domain: requested ?? null, served_domains: served },
    });
  }
  return domain;
}

/**
 * Loads the calling coordinator and checks that it serves `domain`.
 *
 * @param auth - The verified caller.
 * @param domain - The network domain the request acts on.
 * @returns The coordinator, so the caller does not read it again.
 * @throws DB_UNAVAILABLE if the coordinator cannot be read.
 * @throws DOMAIN_NOT_SERVED if the coordinator does not serve `domain`.
 */
export async function requireServedDomain(auth: AuthContext, domain: string): Promise<Coordinator> {
  const coordinator = await loadCallingCoordinator(auth);
  await resolveServedDomain(coordinator, domain);
  return coordinator;
}
