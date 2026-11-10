/**
 * Profile type checks shared by the coordinator routes in `@aggregator-dpg/api`.
 *
 * The profile types a request may act on come from the access token's
 * multivalued `aggregator_type` claim, set when the token is issued. The
 * database is not read. A token refresh picks up a change to the attribute; a
 * change in the console also ends the coordinator's sessions, so it takes
 * effect at once.
 */

import { httpError } from '../errors/http-error.js';
import type { AuthContext } from '../services/auth/access-token.js';
import { getNetworkConfig } from '../services/network-config.js';
import { servedDomains } from '../services/user-store/serves.js';

/**
 * The profile type a request acts on, checked against the token's types.
 *
 * @param auth - The verified caller.
 * @param requested - The profile type named by the request, if any.
 * @param domainIds - The active network's domain ids, in declaration order.
 * @returns `requested`, or the first served type when nothing was requested.
 * @throws DOMAIN_NOT_SERVED if the type is not served, or nothing is served.
 */
function servedDomainFor(
  auth: AuthContext,
  requested: string | undefined,
  domainIds: readonly string[],
): string {
  const served = servedDomains(auth.serves, domainIds);
  const domain = requested ?? served[0];
  if (!domain || !served.includes(domain)) {
    throw httpError('DOMAIN_NOT_SERVED', {
      fields: { requested_domain: requested ?? null, served_domains: served },
    });
  }
  return domain;
}

/**
 * Resolves the profile type a request acts on.
 *
 * Returns `requested` when the token serves it, or the first served type
 * (network order) when nothing was requested.
 *
 * @param auth - The verified caller.
 * @param requested - The profile type named by the request, if any.
 * @returns The domain id to act on.
 * @throws SCHEMA_VALIDATION if `requested` is not a network domain.
 * @throws DOMAIN_NOT_SERVED if the type is not served, or nothing is served.
 */
export async function resolveRequestedDomain(
  auth: AuthContext,
  requested: string | undefined,
): Promise<string> {
  const networkCfg = await getNetworkConfig();
  if (requested !== undefined && !networkCfg.domains[requested]) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: `unknown domain '${requested}' — valid: ${networkCfg.domainIds.join(', ')}`,
    });
  }
  return servedDomainFor(auth, requested, networkCfg.domainIds);
}

/**
 * Checks that the caller's token serves `domain`. The caller validates that
 * `domain` is a network domain first.
 *
 * @param auth - The verified caller.
 * @param domain - The network domain the request acts on.
 * @throws DOMAIN_NOT_SERVED if the token does not serve `domain`.
 */
export async function requireServedDomain(auth: AuthContext, domain: string): Promise<void> {
  const networkCfg = await getNetworkConfig();
  servedDomainFor(auth, domain, networkCfg.domainIds);
}
