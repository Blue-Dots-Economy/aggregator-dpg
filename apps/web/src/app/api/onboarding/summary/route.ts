/**
 * BFF proxy: onboarding metrics summary.
 *   GET /api/onboarding/summary?from=&to=
 *
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
    const upstream = await callApi(`/v1/onboarding/summary${query.search}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'onboarding');
  }
}
