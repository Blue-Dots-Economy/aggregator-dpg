/**
 * Console BFF (RBAC R6): Delete an unused custom role (network admin).
 *   POST /api/console/roles/delete/:key → API POST /v1/roles/delete/:key
 *
 * Guarded by `consoleMutation` (JSON + same-origin, C11) and forwarded with
 * the caller's own token; the upstream envelope passes through unchanged.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { consoleMutation, invalidIdResponse, isRoleKey } from '@/lib/console-proxy';
import { customRolesEnabled } from '@/lib/features.server';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  // Defense in depth: when the custom-roles capability is off the api does not
  // register this route (404). Short-circuit here to avoid a wasted upstream call.
  if (!(await customRolesEnabled())) return invalidIdResponse();
  const { key } = await params;
  if (!isRoleKey(key)) return invalidIdResponse();
  return consoleMutation(req, {
    method: 'POST',
    path: `/v1/roles/delete/${key}`,
    service: 'console',
  });
}
