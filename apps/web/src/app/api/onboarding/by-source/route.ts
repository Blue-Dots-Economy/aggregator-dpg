/**
 * BFF proxy: onboarding metrics grouped by entry source.
 *   GET /api/onboarding/by-source?from=&to=
 *
 * Forwards to the aggregator API's GET /v1/onboarding/by-source.
 * Only `from` and `to` are forwarded, after the same checks the API applies.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/upstream-client';
import { passthrough, proxyFailureResponse } from '@/lib/bff-proxy';
import { parseQuery } from '@/lib/bff-input';

export const runtime = 'nodejs';

/** Same rules as the API's onboarding `RangeQuerySchema`: ISO datetimes with an offset or `Z`. */
const RangeQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const query = parseQuery(req.nextUrl.searchParams, RangeQuerySchema);
  if (!query.ok) return query.response;
  try {
    const upstream = await callApi(`/v1/onboarding/by-source${query.search}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'onboarding');
  }
}
