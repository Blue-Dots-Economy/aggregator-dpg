/**
 * BFF proxy for the active-org dropdown (spec §6 / §6.2).
 *
 * Anonymous browser; forwards `GET /v1/orgs` with a Keycloak service-account
 * token and returns the upstream `{ orgs: [...] }` shape verbatim. Cached
 * `no-store` so a newly-approved org appears without a stale-cache delay.
 *
 * GET /api/orgs
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyServiceRequest } from '../../../lib/bff-service-proxy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  return proxyServiceRequest(req, {
    method: 'GET',
    path: '/v1/orgs',
    route: 'GET /api/orgs',
    cache: 'no-store',
    offlineNoun: 'organisation list',
  });
}
