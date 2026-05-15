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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  let idToken: string | null = null;
  if (sid) {
    const result = await getSessionStore().get(sid);
    if (result.ok) idToken = result.value.idToken;
    await getSessionStore().destroy(sid);
  }

  // Build the post-logout landing URL on /login so the login page can show
  // an "expired" banner and bounce back to the original path after re-auth.
  const reason = req.nextUrl.searchParams.get('reason');
  const returnTo = req.nextUrl.searchParams.get('return');
  const loginUrl = new URL('/login', req.nextUrl.origin);
  if (reason) loginUrl.searchParams.set('reason', reason);
  if (returnTo) loginUrl.searchParams.set('return', returnTo);
  const postLogoutRedirectUri = loginUrl.toString();

  let target = postLogoutRedirectUri;
  if (idToken) {
    const adapter = getOidcAdapter();
    target = await adapter.buildLogoutUrl({ idToken, postLogoutRedirectUri });
  }

  const res = NextResponse.redirect(target, { status: 302 });
  res.cookies.set(SESSION_COOKIE, '', clearCookieOptions());
  return res;
}
