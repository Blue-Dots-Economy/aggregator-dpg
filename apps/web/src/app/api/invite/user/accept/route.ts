/**
 * BFF proxy for registering an invited coordinator.
 *
 * The caller has no session, so this attaches a service-account token and
 * forwards the body to `/v1/user/invite/accept`. Upstream errors pass through.
 *
 * POST /api/invite/user/accept
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyServiceRequest } from '../../../../../lib/bff-service-proxy';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  return proxyServiceRequest(req, {
    method: 'POST',
    path: '/v1/user/invite/accept',
    route: 'POST /api/invite/user/accept',
    forwardJsonBody: true,
    offlineNoun: 'registration service',
  });
}
