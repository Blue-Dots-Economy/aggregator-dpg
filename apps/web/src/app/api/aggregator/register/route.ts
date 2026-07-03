/**
 * BFF proxy for aggregator (coordinator) registration submissions.
 *
 * Anonymous browser; the API requires a Bearer token, so this attaches a
 * Keycloak service-account token and forwards to `/v1/aggregator-registrations/create`.
 * The body is forwarded verbatim (including `org_id` when the org hierarchy is
 * on). Upstream errors pass through in the canonical envelope.
 *
 * POST /api/aggregator/register
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyServiceRequest } from '../../../../lib/bff-service-proxy';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  return proxyServiceRequest(req, {
    method: 'POST',
    path: '/v1/aggregator-registrations/create',
    route: 'POST /api/aggregator/register',
    forwardJsonBody: true,
    offlineNoun: 'registration service',
  });
}
