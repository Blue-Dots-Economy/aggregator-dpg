/**
 * BFF proxy for parent-org registration submissions (spec §6.1).
 *
 * The browser is anonymous (no portal session yet). The aggregator API
 * still requires a Bearer token on every endpoint, so the BFF attaches a
 * Keycloak service-account token from the confidential BFF client
 * (client_credentials grant). Tokens never reach the browser.
 *
 * Upstream API errors (including `ORG_SLUG_TAKEN`, `OWNER_ALREADY_REGISTERED`)
 * are forwarded verbatim — the API is the source of truth for the envelope.
 * This route only synthesises an envelope when the upstream call could not be
 * made at all (no service token, network failure, malformed JSON request).
 *
 * Only meaningful when the API runs with `ORG_HIERARCHY_ENABLED=true`; with the
 * flag off, `/v1/orgs/create` is not registered upstream and returns 404, which
 * this route forwards unchanged.
 *
 * POST /api/org/register
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getServiceAccessToken } from '../../../../lib/service-token';
import { logger, pickRequestId } from '../../../../lib/logger';

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

export async function POST(req: NextRequest): Promise<NextResponse> {
  const reqId = pickRequestId(req.headers);
  const log = logger.child({ reqId, route: 'POST /api/org/register' });
  const start = Date.now();

  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';

  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    log.warn(
      { code: 'BAD_JSON', cause: err instanceof Error ? err.message : String(err) },
      'invalid JSON body',
    );
    return jsonError(
      400,
      envelope('BAD_JSON', 'Invalid request', 'Request body is not valid JSON.', reqId),
      reqId,
    );
  }

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
    upstream = await fetch(`${base}/v1/orgs/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceToken}`,
        [REQUEST_ID_HEADER]: reqId,
      },
      body: JSON.stringify(body),
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
      'org registration upstream call failed',
    );
    return jsonError(
      503,
      envelope(
        'UPSTREAM_UNAVAILABLE',
        'Service temporarily unavailable',
        'The registration service is offline. Please retry shortly.',
        reqId,
      ),
      reqId,
    );
  }

  const latency_ms = Date.now() - start;
  const contentType = upstream.headers.get('content-type') ?? '';

  // Pass upstream body through unchanged — the API renders the canonical
  // envelope for every error and the success body for 2xx.
  if (contentType.includes('application/json')) {
    const data = (await upstream.json()) as unknown;
    log.info(
      {
        status: upstream.status,
        latency_ms,
        upstream_request_id: upstream.headers.get(REQUEST_ID_HEADER),
      },
      'upstream response forwarded',
    );
    const res = NextResponse.json(data, { status: upstream.status });
    res.headers.set(REQUEST_ID_HEADER, reqId);
    return res;
  }

  const text = await upstream.text();
  log.info(
    { status: upstream.status, latency_ms, content_type: contentType },
    'upstream non-JSON response forwarded',
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
