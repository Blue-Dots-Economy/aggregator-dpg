/**
 * Ends an org owner's acting mode in the aggregator portal web app. Server-only.
 *
 * @module apps/web/src/lib/acting-session.server
 */

import { type NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from './cookies';
import { getSessionStore } from './session';
import { expectedOrigin } from './same-origin';
import { safeReturnPath } from './return-to';
import { ACTING_LEAVE_REASONS, CONSOLE_HOME } from './acting';

/**
 * Clears the acting account and the console actor cache, then 303-redirects.
 *
 * The target is `returnTo` when it is a same-origin path, else `/console`. A
 * `reason` from {@link ACTING_LEAVE_REASONS} is added to the target's query.
 *
 * @param req - The request; reads the session cookie and the `returnTo` and `reason` query.
 */
export async function endActing(req: NextRequest): Promise<NextResponse> {
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  if (sid) {
    await getSessionStore().update(sid, { actingAccountId: undefined, consoleActor: undefined });
  }
  const params = req.nextUrl.searchParams;
  const target = new URL(safeReturnPath(params.get('returnTo'), CONSOLE_HOME), expectedOrigin(req));
  const reason = params.get('reason');
  if (reason && ACTING_LEAVE_REASONS.includes(reason)) target.searchParams.set('reason', reason);
  return NextResponse.redirect(target, { status: 303 });
}
