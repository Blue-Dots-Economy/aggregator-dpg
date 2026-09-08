/**
 * Minimal JWT claim reading for the BFF.
 *
 * Decodes a token payload **without verifying the signature** — used only for
 * tokens the BFF received directly from Keycloak over the trusted back-channel
 * (the OIDC exchange / a stored session), so this is a claim read, not a trust
 * boundary. Never use it on tokens from an untrusted caller.
 *
 * @module apps/web/src/lib/jwt
 */

/**
 * Decodes a JWT payload into a claims object, or `null` if it is malformed.
 *
 * @param token - The raw JWT.
 * @returns The decoded payload, or `null`.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/**
 * Returns the non-empty `aggregator_id` claim (the coordinator marker mapped
 * from the Keycloak user attribute), or `null` when absent. Org owners and the
 * network admin have no `aggregator_id`, so this is the portal-access gate.
 *
 * @param token - A Keycloak access token.
 * @returns The aggregator id, or `null`.
 */
export function tokenAggregatorId(token: string): string | null {
  const claims = decodeJwtClaims(token);
  const id = claims?.['aggregator_id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Returns the realm roles carried by a Keycloak access token.
 *
 * Realm roles live under `realm_access.roles`. Used to tell WHICH kind of
 * account a rejected token belongs to: the coordinator portal and the Signals
 * app share one Keycloak realm, so a token can be perfectly valid and still
 * belong to the other application. Knowing that positively — rather than
 * inferring it from the absence of `aggregator_id` — is what lets the login
 * screen say "you're signed in as a Signals account" instead of guessing.
 *
 * @param token - A Keycloak access token.
 * @returns The realm role names, or an empty array when absent/malformed.
 */
export function tokenRealmRoles(token: string): string[] {
  const claims = decodeJwtClaims(token);
  const realmAccess = claims?.['realm_access'];
  if (typeof realmAccess !== 'object' || realmAccess === null) return [];
  const roles = (realmAccess as Record<string, unknown>)['roles'];
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
}

/**
 * Classifies a token that failed the coordinator-portal gate.
 *
 * One shared realm means "no `aggregator_id`" covers three different people,
 * and telling them apart is the difference between actionable copy and a dead
 * end. `signalsRoles` is injected rather than hardcoded because the roles that
 * mark a Signals participant are deployment config on that side.
 *
 * Reads the token WITHOUT verifying its signature, like everything else in
 * this module: the caller has it straight from the code exchange over the
 * trusted back-channel, or from an established session, and the result only
 * selects which message to show. It grants nothing — the access decision was
 * already made by the `aggregator_id` check this classifies the failure of.
 *
 * @param token - A Keycloak access token that lacks `aggregator_id`.
 * @param signalsRoles - Realm roles that identify a Signals participant.
 * @returns Which population the token belongs to.
 */
export function classifyNonCoordinator(
  token: string,
  signalsRoles: readonly string[],
): 'signals_participant' | 'org_owner' | 'unknown' {
  const roles = new Set(tokenRealmRoles(token));
  if (signalsRoles.some((r) => roles.has(r))) return 'signals_participant';
  if (roles.has('org_owner')) return 'org_owner';
  return 'unknown';
}

/**
 * Login-screen reason code for each population the coordinator gate turns away.
 *
 * A table rather than a chain of conditionals: the cases are a closed set that
 * mirrors {@link classifyNonCoordinator}, so a missing one is a type error
 * instead of a silently wrong message. Shared by BOTH gates — the OIDC callback
 * and the protected-layout re-check — so the two can never disagree about what
 * to tell the same user.
 */
export const PORTAL_GATE_REASON: Record<ReturnType<typeof classifyNonCoordinator>, string> = {
  signals_participant: 'signals_account_no_portal',
  org_owner: 'org_no_portal',
  unknown: 'no_portal_access',
};
