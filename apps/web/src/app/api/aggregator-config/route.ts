/**
 * BFF proxy for the aggregator config.
 *
 *   GET /api/aggregator-config
 *
 * Forwards verbatim to the aggregator API's GET /v1/aggregator-config.
 * Surfaces brand + domain labels + url slug to the web app so the
 * sidebar / topbar / dashboard never hardcode "Blue Dots" / "Seekers" /
 * "Providers" — the same image runs purple_dot / yellow_dot / future
 * networks by swapping the upstream config file.
 *
 * Unauthenticated — every value is operator-public.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { serviceUnavailableResponse } from '../../../lib/bff-errors';

export const runtime = 'nodejs';

/**
 * No session required — every value the upstream returns is
 * operator-public (brand, domain labels, url slug). The login page +
 * pre-auth flows also need this payload, so we hit the api directly
 * without a Bearer token instead of going through `callApi`.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  try {
    const upstream = await fetch(`${base}/v1/aggregator-config`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    const ct = upstream.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const data = (await upstream.json()) as unknown;
      return NextResponse.json(data, { status: upstream.status });
    }
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'Content-Type': ct || 'text/plain' },
    });
  } catch (err) {
    return serviceUnavailableResponse(
      'aggregator-config',
      err instanceof Error ? err.message : undefined,
    );
  }
}
