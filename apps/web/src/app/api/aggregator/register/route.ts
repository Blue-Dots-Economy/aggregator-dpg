/**
 * BFF proxy for aggregator registration submissions.
 *
 * The browser is anonymous (no portal session yet). The aggregator API
 * still requires a Bearer token on every endpoint, so the BFF attaches a
 * Keycloak service-account token from the `aggregator-bff` confidential
 * client (client_credentials grant). Tokens never reach the browser.
 *
 * POST /api/aggregator/register
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getServiceAccessToken } from '../../../../lib/service-token';

export const runtime = 'nodejs';

const UPSTREAM_TIMEOUT_MS = 10_000;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'BadRequest', message: 'invalid JSON body' },
      { status: 400 },
    );
  }

  let serviceToken: string;
  try {
    serviceToken = await getServiceAccessToken();
  } catch (err) {
    console.error('[bff] failed to fetch service token', {
      message: err instanceof Error ? err.message : 'unknown',
    });
    return NextResponse.json(
      { error: 'ServiceUnavailable', message: 'identity service unavailable' },
      { status: 503 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/v1/aggregator-registrations/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[bff] aggregator registration upstream call failed', {
      message: err instanceof Error ? err.message : 'unknown',
    });
    return NextResponse.json(
      { error: 'ServiceUnavailable', message: 'registration service unavailable' },
      { status: 503 },
    );
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await upstream.json()) as unknown;
    return NextResponse.json(data, { status: upstream.status });
  }

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'Content-Type': contentType || 'text/plain' },
  });
}
