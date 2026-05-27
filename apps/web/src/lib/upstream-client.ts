/**
 * BFF → upstream API client.
 *
 * Pulls tokens from the active session, transparently refreshes the access
 * token if it is near expiry, and forwards the call to the resource API
 * with a Bearer header. Tokens never reach the browser.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import { cookies } from 'next/headers';
import { getOidcAdapter } from './oidc';
import { getSessionStore, type SessionData } from './session';
import { SESSION_COOKIE } from './cookies';
import { getSession } from './server-session';
import { tracer, webProxyDurationMs } from './telemetry';

const REFRESH_BEFORE_EXPIRY_MS = 60_000;

/**
 * Returns a fresh access token for the active session, refreshing if needed.
 *
 * @returns Access token string, or `null` if no session exists.
 */
export async function getFreshAccessToken(): Promise<string | null> {
  const session = await getSession();
  if (!session) return null;

  if (session.accessTokenExp - Date.now() > REFRESH_BEFORE_EXPIRY_MS) {
    return session.accessToken;
  }

  const refreshed = await getOidcAdapter().refresh(session.refreshToken);
  if (!refreshed.ok) {
    // Refresh failed — kill session, force re-login on next request.
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

export interface UpstreamCallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Calls the resource API with the active session's access token.
 *
 * Wraps the outbound fetch in a `web.api_proxy` OTel span so BFF → API
 * latency is visible in traces. Records duration via `webProxyDurationMs`.
 *
 * @param path - Path relative to `API_BASE_URL` (e.g. `/links`).
 * @param opts - Method, headers, body.
 * @returns The raw `Response`. Caller decides JSON vs text.
 * @throws If no session is active.
 */
export async function callApi(path: string, opts: UpstreamCallOptions = {}): Promise<Response> {
  const accessToken = await getFreshAccessToken();
  if (!accessToken) throw new Error('no active session');

  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  const headers = new Headers(opts.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (opts.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  // Default 15s timeout so a hung upstream cannot block the BFF thread.
  const signal = opts.signal ?? AbortSignal.timeout(15_000);

  return tracer.startActiveSpan('web.api_proxy', async (span) => {
    span.setAttribute('http.route', path);
    const start = Date.now();
    try {
      const res = await fetch(base + path, {
        method: opts.method ?? 'GET',
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal,
      });
      span.setAttribute('http.status_code', res.status);
      if (res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      return res;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      webProxyDurationMs.record(Date.now() - start, { path });
      span.end();
    }
  });
}
