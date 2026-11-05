/**
 * BFF proxy: onboarding metrics grouped by entry source.
 *   GET /api/onboarding/by-source?from=&to=
 *
 * Forwards to the aggregator API's GET /v1/onboarding/by-source.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { callApi } from '../../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../../lib/bff-proxy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const qs = req.nextUrl.search;
    const upstream = await callApi(`/v1/onboarding/by-source${qs}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'onboarding');
  }
}
