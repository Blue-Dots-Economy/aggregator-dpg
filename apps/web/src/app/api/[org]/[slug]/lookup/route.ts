/**
 * BFF proxy for the anonymous identity-probe ("lookup") endpoint.
 *
 *   GET /api/[org]/[slug]/lookup?email|phone_number+network+domain
 *
 * Same anonymous trust model as the public submit route — the `(org, slug)`
 * pair on the public registration link is the only access credential. No
 * service token is attached; the upstream endpoint is itself anonymous.
 *
 * The route forwards the query string verbatim to
 * `/public/v1/aggregators/:orgSlug/lookup` and proxies the upstream
 * status/body back to the browser unchanged. The form uses the response
 * to branch between "open the form fresh" / "resume lifecycle" / "owned
 * elsewhere" UI states.
 */

import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const UPSTREAM_TIMEOUT_MS = 10_000;
const REQUEST_ID_HEADER = 'x-request-id';

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

/**
 * Proxies the lookup query to the aggregator API. Slug is part of the
 * route shape so the BFF surface mirrors the submit route, but the
 * upstream endpoint is keyed only on `orgSlug` — the slug is intentionally
 * ignored when constructing the upstream URL.
 *
 * @param req - The incoming request; the search params are forwarded verbatim.
 * @param params - Path params; `org` becomes the upstream `:orgSlug`.
 * @returns Upstream response proxied with original status and body.
 */
export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { org } = await params;
  const reqId =
    req.headers.get(REQUEST_ID_HEADER) ?? `req-${Math.random().toString(36).slice(2, 10)}`;

  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  const search = new URL(req.url).searchParams.toString();

  // Forward the originating client IP and user-agent so the API rate
  // limiter buckets per real caller, not per BFF instance. Mirrors the
  // submit route's forwarding contract.
  const incomingXff = req.headers.get('x-forwarded-for');
  const clientIp =
    (incomingXff?.split(',')[0]?.trim() ?? '') || ((req as { ip?: string }).ip ?? '');
  const forwardedFor = incomingXff && incomingXff.length > 0 ? incomingXff : clientIp;
  const userAgent = req.headers.get('user-agent') ?? '';

  let upstream: Response;
  try {
    upstream = await fetch(
      `${base}/public/v1/aggregators/${encodeURIComponent(org)}/lookup?${search}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          [REQUEST_ID_HEADER]: reqId,
          ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
          ...(userAgent ? { 'user-agent': userAgent } : {}),
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch (err) {
    return jsonError(
      503,
      envelope(
        'UPSTREAM_UNAVAILABLE',
        'Service temporarily unavailable',
        err instanceof Error ? err.message : 'Could not reach the lookup service.',
        reqId,
      ),
      reqId,
    );
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await upstream.json()) as unknown;
    const res = NextResponse.json(data, { status: upstream.status });
    res.headers.set(REQUEST_ID_HEADER, reqId);
    return res;
  }

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'Content-Type': contentType || 'text/plain', [REQUEST_ID_HEADER]: reqId },
  });
}

function jsonError(status: number, body: BffErrorEnvelope, reqId: string): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set(REQUEST_ID_HEADER, reqId);
  return res;
}
