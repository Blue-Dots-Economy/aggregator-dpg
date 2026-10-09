/**
 * Console BFF (RBAC R3): Grant a capability (e.g. PII Access) to a coordinator.
 *   POST /api/console/user/grant/:id → API POST /v1/user/grant/:id
 *
 * Guarded by `consoleMutation` (JSON + same-origin, C11) and forwarded with
 * the caller's own token; the upstream envelope passes through unchanged.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { consoleMutation, invalidIdResponse, isUuid } from '@/lib/console-proxy';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!isUuid(id)) return invalidIdResponse();
  return consoleMutation(req, {
    method: 'POST',
    path: `/v1/user/grant/${id}`,
    service: 'console',
  });
}
