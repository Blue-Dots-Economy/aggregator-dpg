/**
 * The per-send coordinator-invite cap shown by the public owner-invite page
 * and the console invite page.
 *
 * @module apps/web/src/lib/invite-limit
 */

/** Default cap when the server passes none; matches the API default. */
export const DEFAULT_MAX_INVITES = 10;

/** A positive whole number, or `fallback` for anything else. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads the per-send invite cap from `INVITE_MAX_RECIPIENTS`.
 *
 * Call it on the server at request time, so a restart applies a new value. Set
 * it to the same value as the API's `INVITE_MINT_MAX_RECIPIENTS`. An empty
 * value counts as unset.
 *
 * @param env - The environment to read; defaults to `process.env`.
 * @returns The configured cap, or `DEFAULT_MAX_INVITES` when unset or invalid.
 */
export function resolveMaxInvites(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return positiveInt(env.INVITE_MAX_RECIPIENTS, DEFAULT_MAX_INVITES);
}
