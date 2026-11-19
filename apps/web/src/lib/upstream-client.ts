/**
 * BFF → upstream API client.
 *
 * Uses the session's access token, refreshing it when near expiry, and sends
 * it as a Bearer header. Tokens never reach the browser.
 */

import { cookies, headers as requestHeaders } from 'next/headers';
import { ACTING_ACCOUNT_HEADER } from '@aggregator-dpg/shared-primitives/user-org';
import { getOidcAdapter } from './oidc';
import { getSessionStore, type SessionData } from './session';
import { SESSION_COOKIE } from './cookies';
import { getSession } from './server-session';
import { isConsolePath } from './acting';

const REFRESH_BEFORE_EXPIRY_MS = 60_000;

/**
 * Returns a fresh access token for the active session, refreshing if needed.
 *
 * @returns Access token string, or `null` if no session exists.
 */
export async function getFreshAccessToken(): Promise<string | null> {
  const session = await getSession();
  return session ? freshAccessTokenOf(session) : null;
}

/** Returns the session's access token, refreshed first when near expiry. */
async function freshAccessTokenOf(session: SessionData): Promise<string | null> {
  if (session.accessTokenExp - Date.now() > REFRESH_BEFORE_EXPIRY_MS) {
    return session.accessToken;
  }
  return refreshSessionTokens(session);
}

/**
 * Refreshes the active session's tokens now, whatever their expiry.
 *
 * Used when the caller needs claims written after the current token was
 * issued, such as acting role entries added by a role sync.
 *
 * @returns The new access token, or `null` when there is no session or the refresh failed.
 */
export async function refreshAccessToken(): Promise<string | null> {
  const session = await getSession();
  if (!session) return null;
  return refreshSessionTokens(session);
}

/** Refreshes and stores the session's tokens; a failed refresh ends the session. */
async function refreshSessionTokens(session: SessionData): Promise<string | null> {
  const refreshed = await getOidcAdapter().refresh(session.refreshToken);
  if (!refreshed.ok) {
    // Refresh failed: destroy the session so the next request re-logs in.
    const sid = (await cookies()).get(SESSION_COOKIE)?.value;
    if (sid) await getSessionStore().destroy(sid);
    return null;
  }

  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sid) return null;
  const patch: Partial<SessionData> = {
    accessToken: refreshed.value.accessToken,
    refreshToken: refreshed.value.refreshToken,
    idToken: refreshed.value.idToken,
    accessTokenExp: refreshed.value.accessTokenExp,
    refreshTokenExp: refreshed.value.refreshTokenExp,
  };
  await getSessionStore().update(sid, patch);
  return refreshed.value.accessToken;
}

/**
 * The acting account a call made now names in the acting-account header.
 *
 * None outside acting mode, and none while rendering a console page or
 * serving a console BFF route (read from the `x-pathname` request header the
 * middleware sets), so the console never runs as the coordinator account.
 *
 * @param session - The active session.
 * @returns The acting account id, or `undefined` when the call acts as the signed-in account.
 */
export async function sentActingAccountId(session: SessionData): Promise<string | undefined> {
  if (!session.actingAccountId) return undefined;
  const path = (await requestHeaders()).get('x-pathname');
  return path !== null && isConsolePath(path) ? undefined : session.actingAccountId;
}

export interface UpstreamCallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Call as the signed-in account even when the session acts as another
   * account: the acting-account header is left out.
   */
  asSignedInAccount?: boolean;
}

/**
 * Calls the resource API with the active session's access token.
 *
 * When the session acts as the owner's own coordinator account, the call
 * names it in the acting-account header, unless `opts.asSignedInAccount` is
 * set or the request is a console page or console BFF route.
 *
 * @param path - Path relative to `API_BASE_URL` (e.g. `/links`).
 * @param opts - Method, headers, body.
 * @returns The raw `Response`. Caller decides JSON vs text.
 * @throws If no session is active.
 */
export async function callApi(path: string, opts: UpstreamCallOptions = {}): Promise<Response> {
  const session = await getSession();
  const accessToken = session ? await freshAccessTokenOf(session) : null;
  if (!session || !accessToken) throw new Error('no active session');
  const actingAccountId = opts.asSignedInAccount ? undefined : await sentActingAccountId(session);

  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  const headers = new Headers(opts.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  headers.delete(ACTING_ACCOUNT_HEADER);
  if (actingAccountId) headers.set(ACTING_ACCOUNT_HEADER, actingAccountId);
  if (opts.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  // Default 15s timeout.
  const signal = opts.signal ?? AbortSignal.timeout(15_000);
  return fetch(base + path, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal,
  });
}
