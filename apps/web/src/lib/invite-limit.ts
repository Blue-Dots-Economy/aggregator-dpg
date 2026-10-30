/**
 * The coordinator-invite limits shown by the public owner-invite page and the
 * console invite page.
 *
 * @module apps/web/src/lib/invite-limit
 */

/** Default cap when the server passes none; matches the API default. */
export const DEFAULT_MAX_INVITES = 10;

/** Default invites per organisation per hour; matches the API default. */
export const DEFAULT_HOURLY_INVITES = 200;

/** A positive whole number, or `fallback` for anything else. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads the per-send invite cap from `INVITE_MAX_RECIPIENTS`.
 *
 * Call it on the server at request time, so a restart applies a new value. Set
 * it to the same value as the API's `INVITE_MINT_MAX_RECIPIENTS`. The
 * `NEXT_PUBLIC_INVITE_MAX_RECIPIENTS` name is also accepted. Uses `||` so an
 * empty string falls through to the second name.
 *
 * @param env - The environment to read; defaults to `process.env`.
 * @returns The configured cap, or `DEFAULT_MAX_INVITES` when unset or invalid.
 */
export function resolveMaxInvites(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(
    env.INVITE_MAX_RECIPIENTS || env.NEXT_PUBLIC_INVITE_MAX_RECIPIENTS,
    DEFAULT_MAX_INVITES,
  );
}

/**
 * Reads the hourly per-organisation invite limit from
 * `INVITE_MINT_RATE_MAX_PER_WINDOW`, the name the API uses.
 *
 * Call it on the server at request time. Set it to the same value as the API's.
 *
 * @param env - The environment to read; defaults to `process.env`.
 * @returns The configured limit, or `DEFAULT_HOURLY_INVITES` when unset or invalid.
 */
export function resolveHourlyInvites(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.INVITE_MINT_RATE_MAX_PER_WINDOW, DEFAULT_HOURLY_INVITES);
}
