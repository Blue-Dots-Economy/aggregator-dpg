/**
 * Reading the signed-in user's id from an access token, shared by the API and
 * the web BFF.
 *
 * @module @aggregator-dpg/shared-primitives
 */

/** The claim that carries the user's `users.id`. */
export const USER_ID_CLAIM = 'user_id';

/** The user id a token carries, or `absent`. */
export type UserIdClaim = { kind: 'absent' } | { kind: 'present'; userId: string };

/** A claim a mapper may publish as a string or a one-element list. */
function readSingle(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.length > 0 ? first : undefined;
}

/**
 * Reads the user id from a token's `user_id` claim.
 *
 * @param claims - The decoded token payload; `null` or `undefined` reads as absent.
 * @returns The id, or `absent`.
 */
export function readUserIdClaim(
  claims: Readonly<Record<string, unknown>> | null | undefined,
): UserIdClaim {
  const userId = readSingle(claims?.[USER_ID_CLAIM]);
  return userId === undefined ? { kind: 'absent' } : { kind: 'present', userId };
}
