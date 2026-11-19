/**
 * BFF proxy for the anonymous identity-probe ("lookup") endpoint.
 *
 *   GET /api/[org]/[slug]/lookup?email|phone_number+network+domain
 *
 * Anonymous, like the submit route: no token is attached. Checks the query
 * with the API's rules, forwards only its keys to
 * `/public/v1/aggregators/:orgSlug/lookup`, and returns the upstream status
 * and body unchanged. A query the rules reject answers 400 without an
 * upstream call.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseQuery } from '@/lib/bff-input';
import {
  proxyError,
  proxyToPublicApi,
  requestIdOf,
  type PublicLinkRouteContext,
} from '@/lib/public-proxy';

export const runtime = 'nodejs';

/** Same rules as the API's public lookup `QuerySchema`. */
const LookupQuerySchema = z
  .object({
    email: z.string().trim().check(z.email()).optional(),
    phone_number: z.string().trim().min(1).optional(),
    network: z.string().trim().min(1),
    domain: z.string().trim().min(1),
  })
  .refine((v) => Boolean(v.email) || Boolean(v.phone_number));

/**
 * Proxies the lookup query to the aggregator API.
 *
 * The upstream endpoint is keyed only on `org`; `slug` is ignored.
 *
 * @param req - The incoming request; its checked query keys are forwarded.
 * @param params - Path params; `org` becomes the upstream `:orgSlug`.
 * @returns Upstream response proxied with original status and body.
 */
export async function GET(
  req: NextRequest,
  { params }: PublicLinkRouteContext,
): Promise<NextResponse> {
  const { org } = await params;
  const reqId = requestIdOf(req);

  const query = parseQuery(new URL(req.url).searchParams, LookupQuerySchema);
  if (!query.ok) {
    return proxyError(
      400,
      'SCHEMA_VALIDATION',
      'Invalid query parameters',
      'The lookup query was not accepted.',
      reqId,
    );
  }

  return proxyToPublicApi(req, reqId, {
    method: 'GET',
    path: `/public/v1/aggregators/${encodeURIComponent(org)}/lookup${query.search}`,
    unavailableDetail: 'Could not reach the lookup service.',
  });
}
