/**
 * Reading the signed-in user's id from an access token, shared by the API and
 * the web BFF.
 *
 * The id is published under `user_id` and, while clients move to that name,
 * also under `aggregator_id`. Both hold the user's `users.id`.
 *
 * @module @aggregator-dpg/shared-primitives
 */

/** The claim that carries the user id. */
export const USER_ID_CLAIM = 'user_id';

/** The claim's former name, read only when {@link USER_ID_CLAIM} is absent. */
export const LEGACY_USER_ID_CLAIM = 'aggregator_id';

/**
 * The user id a token carries: absent, one id, or two claims that disagree.
 * A mismatch means the token cannot be trusted to name one user.
 */
export type UserIdClaim =
  { kind: 'absent' } | { kind: 'present'; userId: string } | { kind: 'mismatch' };

/** A claim a mapper may publish as a string or a one-element list. */
function readSingle(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.length > 0 ? first : undefined;
}

/**
 * Reads the user id from a token's claims: `user_id`, else `aggregator_id`.
 *
 * Tokens issued before `user_id` existed carry only `aggregator_id` and keep
 * working. A token that carries both with different values is a mismatch.
 *
 * @param claims - The decoded token payload; `null` or `undefined` reads as absent.
 * @returns The id, `absent`, or `mismatch`.
 */
export function readUserIdClaim(
  claims: Readonly<Record<string, unknown>> | null | undefined,
): UserIdClaim {
  const current = readSingle(claims?.[USER_ID_CLAIM]);
  const legacy = readSingle(claims?.[LEGACY_USER_ID_CLAIM]);
  if (current !== undefined && legacy !== undefined && current !== legacy) {
    return { kind: 'mismatch' };
  }
  const userId = current ?? legacy;
  return userId === undefined ? { kind: 'absent' } : { kind: 'present', userId };
}
