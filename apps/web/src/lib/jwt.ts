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
