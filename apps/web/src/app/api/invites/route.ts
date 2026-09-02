/**
 * BFF proxy for the owner invite-mint endpoint (#701).
 *
 * Anonymous browser (the org owner has no session — their Keycloak user is
 * disabled). Forwards `POST /admin/v1/invites` with a service-account token;
 * the owner GRANT token in the body is the real authorisation. Upstream body
 * (summary or canonical error envelope) is passed through verbatim.
 *
 * POST /api/invites
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyServiceRequest } from '../../../lib/bff-service-proxy';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  return proxyServiceRequest(req, {
    method: 'POST',
    path: '/admin/v1/invites',
    route: 'POST /api/invites',
    forwardJsonBody: true,
    offlineNoun: 'invite service',
  });
}
