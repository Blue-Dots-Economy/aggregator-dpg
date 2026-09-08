/**
 * Starts the OIDC Authorization Code + PKCE flow.
 *
 * - Generates fresh `state`, `nonce`, and PKCE verifier/challenge.
 * - Stores them, plus the desired `returnTo` path, in a signed short-lived
 *   cookie so they survive the Keycloak redirect.
 * - Redirects the browser to Keycloak's `/authorize` endpoint.
 *
 * GET /api/auth/login?returnTo=/dashboard
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getOidcAdapter, oidcGenerators } from '@/lib/oidc';
import { OIDC_FLOW_COOKIE, oidcFlowCookieOptions, signFlowState } from '@/lib/cookies';

export const runtime = 'nodejs';

/**
 * Base used only to resolve a relative `returnTo` into a parsable URL. The
 * `.invalid` TLD is reserved by RFC 2606 and never resolves, so no request
 * is ever made to it; the scheme is `https` purely so no cleartext URL
 * literal exists in the codebase.
 */
const PARSE_BASE = 'https://placeholder.invalid';

function isSafeReturnTo(value: string | null): string {
  if (!value) return '/';
  // Reject anything that does not parse as a same-origin path. This guards
  // against open-redirect tricks like `/%09/evil.com`, `/\\evil.com`,
  // protocol-relative `//evil.com`, and full URLs.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return '/';
  }
  try {
    const parsed = new URL(value, PARSE_BASE);
    if (parsed.origin !== PARSE_BASE) return '/';
    if (/[\x00-\x1f\x7f]/.test(parsed.pathname)) return '/';
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return '/';
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const returnTo = isSafeReturnTo(req.nextUrl.searchParams.get('returnTo'));

  const state = oidcGenerators.state();
  const nonce = oidcGenerators.nonce();
  const codeVerifier = oidcGenerators.codeVerifier();
  const codeChallenge = oidcGenerators.codeChallenge(codeVerifier);

  const redirectUri = mustEnv('OIDC_REDIRECT_URI');
  const adapter = getOidcAdapter();

  // `?switch=1` comes from the "sign in with a different account" action on a
  // cross-app rejection (#753). It must END the realm session, not merely
  // re-prompt: `prompt=login` re-authenticates the CURRENT user, and naming a
  // different one makes Keycloak throw USER_CONFLICT
  // (AuthenticationProcessor.setAutheticatedUser) which it reports as
  // `invalid_user_credentials` — surfaced to the user as "Invalid username or
  // password" on a flow that never asked for a password.
  //
  // The gate rejects before a session exists, so there is no id_token to hint
  // with; Keycloak therefore shows its own logout confirmation. That is the
  // honest prompt here — one realm serves both DPGs, so switching account also
  // ends the Signals session.
  if (req.nextUrl.searchParams.get('switch') === '1') {
    return redirectToAccountSwitch(req, adapter);
  }

  const authUrl = await adapter.buildAuthorizationUrl({
    state,
    nonce,
    codeChallenge,
    redirectUri,
  });

  const res = NextResponse.redirect(authUrl, { status: 302 });
  res.cookies.set(
    OIDC_FLOW_COOKIE,
    signFlowState({ state, nonce, codeVerifier, returnTo }),
    oidcFlowCookieOptions(),
  );
  return res;
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

/** One-shot banner hint read + cleared by the login page. */
const LOGOUT_REASON_COOKIE = 'bd_logout_reason';
const LOGOUT_HINT_MAX_AGE = 300; // 5 minutes

/**
 * Ends the Keycloak session so the next sign-in can name a different account.
 *
 * @param req - Incoming request, for origin fallback and cookie flags.
 * @param adapter - OIDC adapter used to build the end-session URL.
 * @returns Redirect to the IdP end-session endpoint.
 */
async function redirectToAccountSwitch(
  req: NextRequest,
  adapter: ReturnType<typeof getOidcAdapter>,
): Promise<NextResponse> {
  // Same origin rule as the logout route: inside docker `req.nextUrl.origin`
  // is the container bind address, which Keycloak would echo back as a broken
  // redirect. Query strings are stripped by the strict post-logout URI match,
  // so the banner reason travels in a cookie.
  const publicBase =
    process.env.PUBLIC_PORTAL_URL ??
    (process.env.OIDC_POST_LOGOUT_REDIRECT_URI
      ? new URL(process.env.OIDC_POST_LOGOUT_REDIRECT_URI).origin
      : req.nextUrl.origin);
  const target = await adapter.buildLogoutUrl({
    postLogoutRedirectUri: new URL('/login', publicBase).toString(),
  });
  const res = NextResponse.redirect(target, { status: 302 });
  res.cookies.set(LOGOUT_REASON_COOKIE, 'account_switch', {
    httpOnly: false,
    sameSite: 'lax',
    secure: req.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: LOGOUT_HINT_MAX_AGE,
  });
  return res;
}
