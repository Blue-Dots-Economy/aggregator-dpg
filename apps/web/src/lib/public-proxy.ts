/**
 * Shared plumbing for the anonymous public-link BFF proxies
 * (`/api/[org]/[slug]/{submit,lookup,voice-request}`).
 *
 * Those routes take no token: the `(org, slug)` pair grants access. Each one
 * reads its input, then forwards it to the API's `/public/v1/...` surface with
 * the request id, the trusted client IP and the user-agent, and passes the
 * upstream status and body back unchanged. Errors raised here use the BFF
 * error envelope `{ error: { code, title, detail, requestId, timestamp } }`.
 *
 * @module apps/web/src/lib/public-proxy
 */

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { forwardedForHeader } from '@/lib/client-ip';

/** Header carrying the request id, read from the caller and echoed back. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** How long to wait for the API before answering 503. */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** Largest accepted public-link JSON body, in characters; a form submission fits well inside it. */
export const PUBLIC_BODY_MAX_BYTES = 32_000;

/** API base URL used when `API_BASE_URL` is unset (the local dev API). */
const DEFAULT_API_BASE_URL = 'http://localhost:4000';

/** Route-handler context of the `/api/[org]/[slug]/*` public-link routes. */
export interface PublicLinkRouteContext {
  params: Promise<{ org: string; slug: string }>;
}

/** Error body returned by the public proxies. */
export interface BffErrorEnvelope {
  error: {
    code: string;
    title: string;
    detail: string;
    requestId: string;
    timestamp: string;
  };
}

/**
 * Returns the caller's request id, or a fresh one when none was sent.
 *
 * @param req - The incoming request.
 * @returns The request id to forward and echo.
 */
export function requestIdOf(req: Request): string {
  return req.headers.get(REQUEST_ID_HEADER) ?? `req-${randomUUID()}`;
}

/**
 * Builds an error response in the BFF envelope, echoing the request id.
 *
 * @param status - HTTP status.
 * @param code - Machine-readable error code.
 * @param title - Short human title.
 * @param detail - Human detail.
 * @param reqId - Request id to echo.
 * @returns The JSON error response.
 */
export function proxyError(
  status: number,
  code: string,
  title: string,
  detail: string,
  reqId: string,
): NextResponse {
  const body: BffErrorEnvelope = {
    error: { code, title, detail, requestId: reqId, timestamp: new Date().toISOString() },
  };
  const res = NextResponse.json(body, { status });
  res.headers.set(REQUEST_ID_HEADER, reqId);
  return res;
}

/** The parsed request body, or the error response to return instead. */
export type BodyResult = { ok: true; body: unknown } | { ok: false; response: NextResponse };

/**
 * Reads the request body, enforcing the size cap before parsing JSON.
 *
 * @param req - The incoming request.
 * @param reqId - Request id for the error envelope.
 * @param tooLargeTitle - Title of the 413 error, worded for the route.
 * @returns The parsed body (`{}` when empty), or a 400 / 413 response.
 */
export async function readJsonBody(
  req: Request,
  reqId: string,
  tooLargeTitle: string,
): Promise<BodyResult> {
  let raw: string;
  try {
    raw = await req.text();
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Could not read request body.';
    return {
      ok: false,
      response: proxyError(400, 'BAD_REQUEST', 'Invalid request', detail, reqId),
    };
  }
  if (raw.length > PUBLIC_BODY_MAX_BYTES) {
    const detail = `Request body exceeds ${PUBLIC_BODY_MAX_BYTES} bytes.`;
    return {
      ok: false,
      response: proxyError(413, 'PAYLOAD_TOO_LARGE', tooLargeTitle, detail, reqId),
    };
  }
  try {
    return { ok: true, body: raw.length === 0 ? {} : JSON.parse(raw) };
  } catch {
    const detail = 'Request body is not valid JSON.';
    return { ok: false, response: proxyError(400, 'BAD_JSON', 'Invalid request', detail, reqId) };
  }
}

/** What to send upstream: a JSON `POST` with a body, or a `GET`. */
export type PublicProxyCall = ({ method: 'POST'; body: unknown } | { method: 'GET' }) & {
  /** API path (with any query string), already URL-encoded, starting with `/`. */
  path: string;
  /** 503 detail used when the API cannot be reached and the error has no message. */
  unavailableDetail: string;
  /** Copy the upstream `Retry-After` header onto the response. */
  passRetryAfter?: boolean;
};

/**
 * Headers specific to the call's method: a JSON content type for `POST`,
 * a JSON `accept` for `GET`.
 */
function methodHeaders(call: PublicProxyCall): Record<string, string> {
  return call.method === 'POST'
    ? { 'Content-Type': 'application/json' }
    : { accept: 'application/json' };
}

/**
 * Forwards a public-link call to the API and relays its response.
 *
 * Sends the request id, the trusted client IP (see `client-ip.ts`) and the
 * user-agent so the API can rate-limit per caller. An unreachable API (or a
 * timeout) answers 503 `UPSTREAM_UNAVAILABLE`; otherwise the upstream status
 * and body pass through with the request id.
 *
 * @param req - The incoming request (for its headers).
 * @param reqId - Request id to forward and echo.
 * @param call - Method, path, body and 503 wording.
 * @returns The response for the browser.
 */
export async function proxyToPublicApi(
  req: Request,
  reqId: string,
  call: PublicProxyCall,
): Promise<NextResponse> {
  const base = process.env.API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const userAgent = req.headers.get('user-agent') ?? '';

  let upstream: Response;
  try {
    upstream = await fetch(`${base}${call.path}`, {
      method: call.method,
      headers: {
        ...methodHeaders(call),
        [REQUEST_ID_HEADER]: reqId,
        // Only the IP the trusted proxy saw is sent, never the caller's own chain.
        ...forwardedForHeader(req.headers),
        ...(userAgent ? { 'user-agent': userAgent } : {}),
      },
      ...(call.method === 'POST' ? { body: JSON.stringify(call.body) } : { cache: 'no-store' }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : call.unavailableDetail;
    return proxyError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'Service temporarily unavailable',
      detail,
      reqId,
    );
  }

  return relayUpstream(upstream, reqId, call.passRetryAfter === true);
}

/** A JSON `POST` for {@link forwardJsonPost}: the call without its body, plus the 413 title. */
export type JsonPostCall = Omit<Extract<PublicProxyCall, { method: 'POST' }>, 'method' | 'body'> & {
  /** Title of the 413 error, worded for the route. */
  tooLargeTitle: string;
};

/**
 * Reads the request's JSON body and forwards it to the API as a `POST`.
 *
 * @param req - The incoming request.
 * @param call - API path, 413 title, 503 wording and `Retry-After` handling.
 * @returns A 400 / 413 for a bad body, otherwise the relayed API response.
 */
export async function forwardJsonPost(req: Request, call: JsonPostCall): Promise<NextResponse> {
  const reqId = requestIdOf(req);
  const { tooLargeTitle, ...rest } = call;
  const parsed = await readJsonBody(req, reqId, tooLargeTitle);
  if (!parsed.ok) return parsed.response;
  return proxyToPublicApi(req, reqId, { ...rest, method: 'POST', body: parsed.body });
}

/**
 * Passes the upstream status and body through, with the request id and,
 * when asked, any `Retry-After`.
 *
 * @param upstream - The API response.
 * @param reqId - Request id to echo.
 * @param passRetryAfter - Copy the upstream `Retry-After` header.
 * @returns The response for the browser.
 */
async function relayUpstream(
  upstream: Response,
  reqId: string,
  passRetryAfter: boolean,
): Promise<NextResponse> {
  const contentType = upstream.headers.get('content-type') ?? '';
  const res = contentType.includes('application/json')
    ? NextResponse.json(await upstream.json(), { status: upstream.status })
    : new NextResponse(await upstream.text(), {
        status: upstream.status,
        headers: { 'Content-Type': contentType || 'text/plain' },
      });
  res.headers.set(REQUEST_ID_HEADER, reqId);
  const retryAfter = upstream.headers.get('retry-after');
  if (passRetryAfter && retryAfter) res.headers.set('retry-after', retryAfter);
  return res;
}
