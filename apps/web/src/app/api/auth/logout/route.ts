/**
 * RP-initiated logout.
 *
 * - Destroys the Redis session.
 * - Clears the `sid` cookie.
 * - Redirects to Keycloak's end-session endpoint with `id_token_hint` so the
 *   IdP-side SSO session is also killed.
 *
 * GET /api/auth/logout
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getOidcAdapter } from '@/lib/oidc';
import { getSessionStore } from '@/lib/session';
import { SESSION_COOKIE, clearCookieOptions } from '@/lib/cookies';

export const runtime = 'nodejs';

/**
 * Keycloak validates `post_logout_redirect_uri` against the client's
 * registered URIs exactly (no query-string allowance unless wildcards are
 * configured). Sending `/login?reason=...&return=...` fails with
 * "Invalid redirect uri". So we keep the redirect bare and carry the
 * banner reason + post-login return path through these short-lived
 * cookies; the login page reads + clears them on first render.
 */
const LOGOUT_REASON_COOKIE = 'bd_logout_reason';
const LOGOUT_RETURN_COOKIE = 'bd_logout_return';
const LOGOUT_HINT_MAX_AGE = 300; // 5 minutes

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  let idToken: string | null = null;
  if (sid) {
    const result = await getSessionStore().get(sid);
    if (result.ok) idToken = result.value.idToken;
    await getSessionStore().destroy(sid);
  }

  // Always send Keycloak to the bare /login path — query strings break the
  // strict redirect-URI match. The login page picks up reason + return from
  // the cookies below.
  const postLogoutRedirectUri = new URL('/login', req.nextUrl.origin).toString();

  let target = postLogoutRedirectUri;
  if (idToken) {
    const adapter = getOidcAdapter();
    target = await adapter.buildLogoutUrl({ idToken, postLogoutRedirectUri });
  }

  const reason = req.nextUrl.searchParams.get('reason');
  const returnTo = req.nextUrl.searchParams.get('return');

  const res = NextResponse.redirect(target, { status: 302 });
  res.cookies.set(SESSION_COOKIE, '', clearCookieOptions());

  const hintOpts = {
    httpOnly: false, // login page reads them on the server, but no harm in client visibility
    sameSite: 'lax' as const,
    secure: req.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: LOGOUT_HINT_MAX_AGE,
  };
  if (reason) res.cookies.set(LOGOUT_REASON_COOKIE, reason, hintOpts);
  if (returnTo) res.cookies.set(LOGOUT_RETURN_COOKIE, returnTo, hintOpts);

  return res;
}
