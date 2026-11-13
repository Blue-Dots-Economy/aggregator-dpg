/**
 * BFF proxy for registering an invited organisation.
 *
 * The caller has no session, so this attaches a service-account token and
 * forwards the body to `/v1/org/invite/accept`. Upstream errors pass through.
 *
 * POST /api/invite/org/accept
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyServiceRequest } from '../../../../../lib/bff-service-proxy';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  return proxyServiceRequest(req, {
    method: 'POST',
    path: '/v1/org/invite/accept',
    route: 'POST /api/invite/org/accept',
    forwardJsonBody: true,
    offlineNoun: 'registration service',
  });
}
