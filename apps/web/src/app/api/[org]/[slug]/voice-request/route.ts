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

export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { org, slug } = await params;
  const reqId = req.headers.get(REQUEST_ID_HEADER) ?? `req-${randomUUID()}`;

  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';

  // Read raw text first to enforce the size cap before parsing JSON.
  let raw: string;
  try {
    raw = await req.text();
  } catch (err) {
    return jsonError(
      400,
      envelope(
        'BAD_REQUEST',
        'Invalid request',
        err instanceof Error ? err.message : 'Could not read request body.',
        reqId,
      ),
      reqId,
    );
  }
  if (raw.length > MAX_BODY_BYTES) {
    return jsonError(
      413,
      envelope(
        'PAYLOAD_TOO_LARGE',
        'Request too large',
        `Request body exceeds ${MAX_BODY_BYTES} bytes.`,
        reqId,
      ),
      reqId,
    );
  }
  let body: unknown;
  try {
    body = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return jsonError(
      400,
      envelope('BAD_JSON', 'Invalid request', 'Request body is not valid JSON.', reqId),
      reqId,
    );
  }

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
        body: JSON.stringify(body),
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

  const contentType = upstream.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data: unknown = await upstream.json();
    const res = NextResponse.json(data, { status: upstream.status });
    res.headers.set(REQUEST_ID_HEADER, reqId);
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) res.headers.set('retry-after', retryAfter);
    return res;
  }

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: {
      'Content-Type': contentType || 'text/plain',
      [REQUEST_ID_HEADER]: reqId,
      ...(upstream.headers.get('retry-after')
        ? { 'retry-after': upstream.headers.get('retry-after') ?? '' }
        : {}),
    },
  });
}

function jsonError(status: number, body: BffErrorEnvelope, reqId: string): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set(REQUEST_ID_HEADER, reqId);
  return res;
}
