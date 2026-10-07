/**
 * Console BFF (user & org Phase 5): invite coordinators into an organisation.
 *   POST /api/console/user/invite → API POST /v1/user/create
 *
 * Guarded by `consoleMutation` (JSON + same-origin, C11) and forwarded with
 * the caller's own token; the upstream envelope passes through unchanged.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { consoleMutation } from '@/lib/console-proxy';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  return consoleMutation(req, { method: 'POST', path: '/v1/user/create', service: 'console' });
}
