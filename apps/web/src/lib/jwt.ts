/**
 * Minimal JWT claim reading for the BFF.
 *
 * Decodes a token payload without verifying the signature. Use only on tokens
 * the BFF got from Keycloak directly (code exchange or stored session). Never
 * use it on tokens from an untrusted caller.
 *
 * @module apps/web/src/lib/jwt
 */

import { readUserIdClaim } from '@aggregator-dpg/shared-primitives/user-id-claim';
import { readJsonObject } from './json-object';

/**
 * Decodes a JWT payload into a claims object, or `null` if it is malformed or not an object.
 *
 * @param token - The raw JWT.
 * @returns The decoded payload, or `null`.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return readJsonObject(JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

/**
 * Returns the coordinator's user id: the `user_id` claim.
 *
 * Only coordinators have it; org owners and the network admin do not.
 *
 * @param token - A Keycloak access token.
 * @returns The user id, or `null`.
 */
export function tokenUserId(token: string): string | null {
  const claim = readUserIdClaim(decodeJwtClaims(token));
  return claim.kind === 'present' ? claim.userId : null;
}

/**
 * Returns the realm roles carried by a Keycloak access token.
 *
 * Reads `realm_access.roles`. Used to tell which kind of account a rejected
 * token belongs to, since the portal and Signals share one realm.
 *
 * @param token - A Keycloak access token.
 * @returns The realm role names, or an empty array when absent/malformed.
 */
export function tokenRealmRoles(token: string): string[] {
  const claims = decodeJwtClaims(token);
  const roles = readJsonObject(claims?.['realm_access'])?.['roles'];
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
}

/**
 * Classifies a token that failed the coordinator-portal gate.
 *
 * The result only picks which login message to show; it grants no access.
 * The signature is not verified (see the module note).
 *
 * @param token - A Keycloak access token that lacks `user_id`.
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
 * Login-screen reason code for each population the portal turns away.
 *
 * Org owners are not listed; they are sent to `/console` instead. Used by both
 * the OIDC callback and the protected layout so they agree.
 */
export const PORTAL_GATE_REASON: Record<
  Exclude<ReturnType<typeof classifyNonCoordinator>, 'org_owner'>,
  string
> = {
  signals_participant: 'signals_account_no_portal',
  unknown: 'no_portal_access',
};
