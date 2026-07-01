/**
 * BFF proxy for the active-org dropdown (spec §6 / §6.2).
 *
 * Anonymous browser, but the upstream `GET /v1/orgs` requires a Bearer token,
 * so the BFF attaches a Keycloak service-account token (client_credentials).
 * Returns the upstream `{ orgs: [...] }` shape verbatim. Cached `no-store` so
 * a newly-approved org appears without a stale-cache delay.
 *
 * Only meaningful with `ORG_HIERARCHY_ENABLED=true` upstream; with the flag off
 * the upstream route is unregistered (404) and this forwards it unchanged.
 *
 * GET /api/orgs
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getServiceAccessToken } from '../../../lib/service-token';
import { logger, pickRequestId } from '../../../lib/logger';

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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const reqId = pickRequestId(req.headers);
  const log = logger.child({ reqId, route: 'GET /api/orgs' });
  const start = Date.now();

  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';

  let serviceToken: string;
  try {
    serviceToken = await getServiceAccessToken();
  } catch (err) {
    log.error(
      {
        code: 'IDP_UNAVAILABLE',
        sub_operation: 'getServiceAccessToken',
        cause: err instanceof Error ? err.message : String(err),
        hint: 'Keycloak token endpoint failed. Check KEYCLOAK_INTERNAL_URL + client credentials.',
      },
      'failed to fetch service token',
    );
    return jsonError(
      503,
      envelope(
        'IDP_UNAVAILABLE',
        'Identity service unavailable',
        'The identity service is temporarily unreachable. Please try again shortly.',
        reqId,
      ),
      reqId,
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/v1/orgs`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        [REQUEST_ID_HEADER]: reqId,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    log.error(
      {
        code: 'UPSTREAM_UNAVAILABLE',
        sub_operation: 'fetch.aggregator-api',
        cause: err instanceof Error ? err.message : String(err),
        hint: 'Aggregator API unreachable from BFF. Check API_BASE_URL + network.',
      },
      'org list upstream call failed',
    );
    return jsonError(
      503,
      envelope(
        'UPSTREAM_UNAVAILABLE',
        'Service temporarily unavailable',
        'The organisation list is offline. Please retry shortly.',
        reqId,
      ),
      reqId,
    );
  }

  const latency_ms = Date.now() - start;
  const contentType = upstream.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const data = (await upstream.json()) as unknown;
    log.info({ status: upstream.status, latency_ms }, 'upstream org list forwarded');
    const res = NextResponse.json(data, { status: upstream.status });
    res.headers.set(REQUEST_ID_HEADER, reqId);
    return res;
  }

  const text = await upstream.text();
  log.info(
    { status: upstream.status, latency_ms, content_type: contentType },
    'upstream non-JSON org list forwarded',
  );
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
