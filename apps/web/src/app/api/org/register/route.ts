/**
 * BFF proxy for parent-org registration submissions (spec §6.1).
 *
 * Anonymous browser; the API still needs a Bearer token, so this attaches a
 * Keycloak service-account token and forwards to `/v1/orgs/create`. Upstream
 * errors (`ORG_SLUG_TAKEN`, `OWNER_ALREADY_REGISTERED`, …) pass through verbatim.
 * Only meaningful when the API runs with `ORG_HIERARCHY_ENABLED=true`.
 *
 * POST /api/org/register
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyServiceRequest } from '../../../../lib/bff-service-proxy';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  return proxyServiceRequest(req, {
    method: 'POST',
    path: '/v1/orgs/create',
    route: 'POST /api/org/register',
    forwardJsonBody: true,
    offlineNoun: 'registration service',
  });
}
