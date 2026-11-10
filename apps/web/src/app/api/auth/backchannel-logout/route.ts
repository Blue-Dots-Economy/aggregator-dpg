/**
 * Keycloak back-channel logout.
 *
 * Keycloak calls this server to server when one of its sessions ends, for
 * example a sign-out or account switch in Signals, which shares the realm. The
 * portal sessions created under that Keycloak session end at once, so an open
 * portal tab goes to the sign-in page on its next request instead of showing
 * the old account until its access token runs out.
 *
 * Not rate-limited: Keycloak calls it from one address in bursts when many
 * sessions end, and nothing happens without a correctly signed token.
 *
 * POST /api/auth/backchannel-logout (form body: `logout_token`)
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getOidcAdapter } from '@/lib/oidc';
import { getSessionStore } from '@/lib/session';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(req: NextRequest): Promise<NextResponse> {
  let logoutToken: string | null = null;
  try {
    const form = await req.formData();
    const value = form.get('logout_token');
    if (typeof value === 'string' && value) logoutToken = value;
  } catch {
    // Not a form body: answered below as a missing token.
  }
  if (!logoutToken) {
    return NextResponse.json({ error: 'LOGOUT_TOKEN_MISSING' }, { status: 400, headers: NO_STORE });
  }

  const verified = await getOidcAdapter().verifyLogoutToken(logoutToken);
  if (!verified.ok) {
    logger.warn({
      operation: 'auth.backchannelLogout',
      status: 'failure',
      code: verified.error.code,
      error: verified.error.message,
    });
    const status = verified.error.code === 'LOGOUT_TOKEN_INVALID' ? 400 : 503;
    return NextResponse.json({ error: verified.error.code }, { status, headers: NO_STORE });
  }

  const ended = await getSessionStore().destroyByIdpSession(verified.value.sid);
  logger.info({ operation: 'auth.backchannelLogout', status: 'success', ended });
  return new NextResponse(null, { status: 200, headers: NO_STORE });
}
