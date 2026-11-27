/**
 * Console BFF: invite organisations to register under an organisation.
 *   POST /api/console/org/invite → API POST /v1/org/invite
 *
 * Guarded by `consoleMutation` (JSON body, same-origin) and sent with the
 * caller's own token. The upstream response passes through unchanged.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { consoleMutation } from '@/lib/console-proxy';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  return consoleMutation(req, { method: 'POST', path: '/v1/org/invite', service: 'console' });
}
