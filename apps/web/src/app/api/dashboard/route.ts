/**
 * BFF proxy for the signalstack-backed aggregator dashboard.
 *
 *   GET /api/dashboard?domain=seeker&page&limit&status
 *
 * Forwards to the aggregator API's GET /v1/dashboard with the session's
 * access token. Without `status`, the upstream returns the full rollup.
 * The query is checked with the API's rules and only its keys are forwarded.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/upstream-client';
import { passthrough, proxyFailureResponse } from '@/lib/bff-proxy';
import { parseQuery } from '@/lib/bff-input';

export const runtime = 'nodejs';

/**
 * Same rules as the API's `DashboardQuerySchema`. `refresh` is any string:
 * the API coerces it, and it is forwarded as sent.
 */
const DashboardQuerySchema = z.object({
  domain: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  status: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_]+$/i)
    .optional(),
  lifecycle: z.enum(['draft', 'live']).optional(),
  refresh: z.string().optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const query = parseQuery(req.nextUrl.searchParams, DashboardQuerySchema);
  if (!query.ok) return query.response;
  try {
    const upstream = await callApi(`/v1/dashboard${query.search}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'dashboard');
  }
}
