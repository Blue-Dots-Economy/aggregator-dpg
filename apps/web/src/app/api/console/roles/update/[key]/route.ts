/**
 * Console BFF (RBAC R6): Change a custom role (network admin).
 *   PATCH /api/console/roles/update/:key → API PATCH /v1/roles/update/:key
 *
 * Guarded by `consoleMutation` (JSON + same-origin, C11) and forwarded with
 * the caller's own token; the upstream envelope passes through unchanged.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { consoleMutation, invalidIdResponse, isRoleKey } from '@/lib/console-proxy';

export const runtime = 'nodejs';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const { key } = await params;
  if (!isRoleKey(key)) return invalidIdResponse();
  return consoleMutation(req, {
    method: 'PATCH',
    path: `/v1/roles/update/${key}`,
    service: 'console',
  });
}
