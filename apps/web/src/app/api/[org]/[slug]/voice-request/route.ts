/**
 * BFF proxy for anonymous voice-bot requests.
 *
 * The caller is unauthenticated; the `(org, slug)` pair grants access.
 * Forwards the JSON body to `/public/v1/aggregators/:orgSlug/voice-requests/:slug`
 * with no Bearer or service token. The upstream status and body pass through,
 * and a `Retry-After` header is kept.
 *
 * POST /api/[org]/[slug]/voice-request
 */

import { randomUUID } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { forwardedForHeader } from '@/lib/client-ip';

export const runtime = 'nodejs';

const UPSTREAM_TIMEOUT_MS = 10_000;
const REQUEST_ID_HEADER = 'x-request-id';
/**
 * Maximum voice-request body size in bytes.
 */
const MAX_BODY_BYTES = 32_000;

interface BffErrorEnvelope {
  error: {
    code: string;
    title: string;
    detail: string;
    requestId: string;
    timestamp: string;
  };
}

function envelope(
  code: string,
  title: string,
  detail: string,
  requestId: string,
): BffErrorEnvelope {
  return {
    error: { code, title, detail, requestId, timestamp: new Date().toISOString() },
  };
}

interface RouteParams {
  params: Promise<{ org: string; slug: string }>;
}

/** The parsed request body, or the error response to return instead. */
type BodyResult = { ok: true; body: unknown } | { ok: false; response: NextResponse };

/**
 * Reads the request body, enforcing the size cap before parsing JSON.
 *
 * @param req - The incoming request.
 * @param reqId - Request id for the error envelope.
 * @returns The parsed body (`{}` when empty), or a 400 / 413 response.
 */
async function readJsonBody(req: NextRequest, reqId: string): Promise<BodyResult> {
  let raw: string;
  try {
    raw = await req.text();
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Could not read request body.';
    return {
      ok: false,
      response: jsonError(400, envelope('BAD_REQUEST', 'Invalid request', detail, reqId), reqId),
    };
  }
  if (raw.length > MAX_BODY_BYTES) {
    const detail = `Request body exceeds ${MAX_BODY_BYTES} bytes.`;
    return {
      ok: false,
      response: jsonError(
        413,
        envelope('PAYLOAD_TOO_LARGE', 'Request too large', detail, reqId),
        reqId,
      ),
    };
  }
  try {
    return { ok: true, body: raw.length === 0 ? {} : JSON.parse(raw) };
  } catch {
    const detail = 'Request body is not valid JSON.';
    return {
      ok: false,
      response: jsonError(400, envelope('BAD_JSON', 'Invalid request', detail, reqId), reqId),
    };
  }
}

/**
 * Passes the upstream status and body through, with the request id and any `Retry-After`.
 *
 * @param upstream - The API response.
 * @param reqId - Request id to echo.
 * @returns The response for the browser.
 */
async function relayUpstream(upstream: Response, reqId: string): Promise<NextResponse> {
  const contentType = upstream.headers.get('content-type') ?? '';
  const retryAfter = upstream.headers.get('retry-after');
  const res = contentType.includes('application/json')
    ? NextResponse.json(await upstream.json(), { status: upstream.status })
    : new NextResponse(await upstream.text(), {
        status: upstream.status,
        headers: { 'Content-Type': contentType || 'text/plain' },
      });
  res.headers.set(REQUEST_ID_HEADER, reqId);
  if (retryAfter) res.headers.set('retry-after', retryAfter);
  return res;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { org, slug } = await params;
  const reqId = req.headers.get(REQUEST_ID_HEADER) ?? `req-${randomUUID()}`;

  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';

  const parsed = await readJsonBody(req, reqId);
  if (!parsed.ok) return parsed.response;

  // Forward the client IP and user-agent so the API rate-limits per caller.
  // Only the IP the trusted proxy saw is sent, never the caller's own chain.
  const forwardedFor = forwardedForHeader(req.headers);
  const userAgent = req.headers.get('user-agent') ?? '';

  let upstream: Response;
  try {
    upstream = await fetch(
      `${base}/public/v1/aggregators/${encodeURIComponent(org)}/voice-requests/${encodeURIComponent(slug)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: reqId,
          ...forwardedFor,
          ...(userAgent ? { 'user-agent': userAgent } : {}),
        },
        body: JSON.stringify(parsed.body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch (err) {
    return jsonError(
      503,
      envelope(
        'UPSTREAM_UNAVAILABLE',
        'Service temporarily unavailable',
        err instanceof Error ? err.message : 'Could not reach the registration service.',
        reqId,
      ),
      reqId,
    );
  }

  return relayUpstream(upstream, reqId);
}

function jsonError(status: number, body: BffErrorEnvelope, reqId: string): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set(REQUEST_ID_HEADER, reqId);
  return res;
}
