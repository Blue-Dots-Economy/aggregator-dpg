/**
 * BFF proxy for expired-grant recovery (#701).
 *
 * Forwards `POST /admin/v1/invites/grant/renew` with a service-account token.
 * The upstream mints a fresh grant and emails it to the org's REGISTERED owner
 * address (never a request-supplied one), so this route carries no email input.
 *
 * POST /api/invites/grant/renew
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyServiceRequest } from '../../../../../lib/bff-service-proxy';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  return proxyServiceRequest(req, {
    method: 'POST',
    path: '/admin/v1/invites/grant/renew',
    route: 'POST /api/invites/grant/renew',
    forwardJsonBody: true,
    offlineNoun: 'invite service',
  });
}
