/**
 * Console BFF (RBAC R3): Set an organisation's own PermissionSet (network admin).
 *   PATCH /api/console/org/permission-set/:id → API PATCH /v1/org/permission-set/update/:id
 *
 * Guarded by `consoleMutation` (JSON + same-origin, C11) and forwarded with
 * the caller's own token; the upstream envelope passes through unchanged.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { consoleMutation, invalidIdResponse, isUuid } from '@/lib/console-proxy';

export const runtime = 'nodejs';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!isUuid(id)) return invalidIdResponse();
  return consoleMutation(req, {
    method: 'PATCH',
    path: `/v1/org/permission-set/update/${id}`,
    service: 'console',
  });
}
