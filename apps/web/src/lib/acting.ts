/**
 * Shared names for an org owner's acting mode in the aggregator portal web app.
 *
 * Safe to import from client and server code.
 *
 * @module apps/web/src/lib/acting
 */

/** The GET route that ends acting mode and redirects; a server redirect can reach it. */
export const ACTING_LEAVE_PATH = '/api/auth/acting/leave';

/** Where leaving acting mode lands without another target. */
export const CONSOLE_HOME = '/console';

/** The API's `403` code for an acting account that can no longer be used. */
export const ACTING_ACCOUNT_INVALID = 'ACTING_ACCOUNT_INVALID';

/** Why acting mode ended, shown as a notice on the console. */
export const ACTING_ENDED_REASON = 'acting_ended';

/** Reasons the leave route passes on to its target; anything else is dropped. */
export const ACTING_LEAVE_REASONS: readonly string[] = [ACTING_ENDED_REASON];

/**
 * The URL that ends acting mode and goes to `returnTo`.
 *
 * @param returnTo - A same-origin path; the route falls back to `/console` otherwise.
 * @param reason - One of {@link ACTING_LEAVE_REASONS}, passed on to the target.
 */
export function actingLeaveHref(returnTo: string, reason?: string): string {
  const q = new URLSearchParams({ returnTo });
  if (reason) q.set('reason', reason);
  return `${ACTING_LEAVE_PATH}?${q.toString()}`;
}

/** Ends acting mode because the account can no longer be used, and shows the console notice. */
export const ACTING_ENDED_HREF = actingLeaveHref(CONSOLE_HOME, ACTING_ENDED_REASON);
