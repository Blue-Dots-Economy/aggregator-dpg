/**
 * Shared GET handler for the BFF's onboarding metrics routes.
 *
 * Both routes take the same `from` / `to` range and optional `domain`
 * (profile type), check them with the API's rules, and forward them with the
 * caller's own token via `callApi`.
 *
 * @module apps/web/src/lib/onboarding-proxy
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/upstream-client';
import { passthrough, proxyFailureResponse } from '@/lib/bff-proxy';
import { parseQuery } from '@/lib/bff-input';

/** Same rules as the API's onboarding `RangeQuerySchema`: ISO datetimes with an offset or `Z`, and a profile type. */
const RangeQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  domain: z.string().min(1).optional(),
});

/**
 * Forwards an onboarding metrics read after checking its query.
 *
 * @param req - The incoming request.
 * @param path - Upstream path, e.g. `/v1/onboarding/summary`.
 * @returns The upstream response, a 400 for a bad query, or the proxy's 401 / 503.
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
