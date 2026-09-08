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
  // cross-app rejection. Without prompt=login Keycloak reuses the existing
  // realm SSO session and the user lands back on the same error (#753).
  const forceReauth = req.nextUrl.searchParams.get('switch') === '1';
  const authUrl = await adapter.buildAuthorizationUrl({
    state,
    nonce,
    codeChallenge,
    redirectUri,
    ...(forceReauth ? { prompt: 'login' as const } : {}),
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
