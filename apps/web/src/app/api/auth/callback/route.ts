/**
 * OIDC redirect URI — completes the login flow.
 *
 * - Reads the signed flow cookie set by `/api/auth/login`.
 * - Verifies state, exchanges the auth code (with PKCE verifier) for tokens.
 * - Persists the session in Redis.
 * - Drops the `sid` cookie.
 * - Redirects to the original `returnTo` path.
 *
 * GET /api/auth/callback?code=...&state=...
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getOidcAdapter } from '@/lib/oidc';
import { getSessionStore, type SessionData } from '@/lib/session';
import {
  OIDC_FLOW_COOKIE,
  SESSION_COOKIE,
  clearCookieOptions,
  sessionCookieOptions,
  verifyFlowState,
} from '@/lib/cookies';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = req.nextUrl;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oidcError = url.searchParams.get('error');
  const oidcErrorDesc = url.searchParams.get('error_description');

  if (oidcError) {
    console.error('[auth/callback] oidc error from idp', { oidcError, oidcErrorDesc });
    return failure(req, `oidc_error_${oidcError}`);
  }
  if (!code || !state) {
    return failure(req, 'missing_code_or_state');
  }

  const flowCookie = req.cookies.get(OIDC_FLOW_COOKIE)?.value;
  const flow = verifyFlowState(flowCookie);
  if (!flow) {
    return failure(req, 'invalid_flow_cookie');
  }

  const redirectUri = mustEnv('OIDC_REDIRECT_URI');
  const adapter = getOidcAdapter();
  const callbackParams: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    callbackParams[key] = value;
  });
  const exchanged = await adapter.exchangeCode({
    code,
    codeVerifier: flow.codeVerifier,
    redirectUri,
    state,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    callbackParams,
  });
  if (!exchanged.ok) {
    console.error('[auth/callback] token exchange failed', exchanged.error);
    return failure(req, `exchange_${exchanged.error.code.toLowerCase()}`);
  }

  const { tokens, claims } = exchanged.value;
  const now = Date.now();
  const sessionData: SessionData = {
    sub: claims.sub,
    ...(claims.email ? { email: claims.email } : {}),
    ...(claims.phoneNumber ? { phone: claims.phoneNumber } : {}),
    ...(claims.name ? { name: claims.name } : {}),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken,
    accessTokenExp: tokens.accessTokenExp,
    refreshTokenExp: tokens.refreshTokenExp,
    createdAt: now,
    lastSeenAt: now,
  };
  const sid = await getSessionStore().create(sessionData);

  const res = NextResponse.redirect(absoluteUrl(req, flow.returnTo), { status: 302 });
  res.cookies.set(SESSION_COOKIE, sid, sessionCookieOptions());
  res.cookies.set(OIDC_FLOW_COOKIE, '', clearCookieOptions());
  return res;
}

function failure(req: NextRequest, reason: string): NextResponse {
  const target = absoluteUrl(req, `/login?error=${encodeURIComponent(reason)}`);
  const res = NextResponse.redirect(target, { status: 302 });
  res.cookies.set(OIDC_FLOW_COOKIE, '', clearCookieOptions());
  return res;
}

function absoluteUrl(req: NextRequest, path: string): string {
  return new URL(path, req.nextUrl.origin).toString();
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}
