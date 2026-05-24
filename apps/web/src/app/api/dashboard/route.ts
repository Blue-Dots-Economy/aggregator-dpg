/**
 * BFF proxy for the signalstack-backed aggregator dashboard.
 *
 *   GET /api/dashboard?domain=seeker&page&limit&status
 *
 * Forwards verbatim to the aggregator API's
 * GET /v1/dashboard endpoint. Session cookie → access token
 * swap is handled by callApi. Status is optional — the default fetch
 * (no status param) returns the full rollup so the dashboard can render
 * the totals + a local view, and the client refetches with
 * `?status=<chip>` when the user selects a server-side status filter.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '../../../lib/bff-errors';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const search = req.nextUrl.searchParams.toString();
  const path = `/v1/dashboard${search ? `?${search}` : ''}`;
  try {
    const upstream = await callApi(path, { method: 'GET' });
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
    if (err instanceof Error && err.message === 'no active session') {
      return unauthorizedResponse();
    }
    return serviceUnavailableResponse('dashboard', err instanceof Error ? err.message : undefined);
  }
}
