/**
 * BFF proxy for the signalstack-backed aggregator dashboard.
 *
 *   GET /api/dashboard?domain=seeker&page&limit&status
 *
 * Forwards to the aggregator API's GET /v1/dashboard with the session's
 * access token. Without `status`, the upstream returns the full rollup.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { callApi } from '../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../lib/bff-proxy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const search = req.nextUrl.searchParams.toString();
  const path = `/v1/dashboard${search ? `?${search}` : ''}`;
  try {
    const upstream = await callApi(path, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'dashboard');
  }
}
