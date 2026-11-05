/**
 * Shared GET handler for the BFF's onboarding metrics routes.
 *
 * Both routes take the same `from` / `to` range, check it with the API's
 * rules, and forward it with the caller's own token via `callApi`.
 *
 * @module apps/web/src/lib/onboarding-proxy
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/upstream-client';
import { passthrough, proxyFailureResponse } from '@/lib/bff-proxy';
import { parseQuery } from '@/lib/bff-input';

/** Same rules as the API's onboarding `RangeQuerySchema`: ISO datetimes with an offset or `Z`. */
const RangeQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/**
 * Forwards an onboarding metrics read after checking its range query.
 *
 * @param req - The incoming request.
 * @param path - Upstream path, e.g. `/v1/onboarding/summary`.
 * @returns The upstream response, a 400 for a bad range, or the proxy's 401 / 503.
 */
export async function proxyOnboardingRead(req: NextRequest, path: string): Promise<NextResponse> {
  const query = parseQuery(req.nextUrl.searchParams, RangeQuerySchema);
  if (!query.ok) return query.response;
  try {
    const upstream = await callApi(`${path}${query.search}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'onboarding');
  }
}
