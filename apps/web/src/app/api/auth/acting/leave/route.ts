/**
 * Ends acting mode from a server redirect or a link.
 *
 * Mirrors `DELETE /api/auth/acting` as a GET, because `redirect()` and a link
 * cannot send a DELETE. Like `GET /api/auth/logout` it only drops access, so a
 * cross-site request can do no more than end acting mode.
 *
 * GET /api/auth/acting/leave?returnTo=<path>&reason=<reason> → 303 to `returnTo`
 * (same-origin path) or `/console`, with an allowed `reason` kept in the query.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { endActing } from '@/lib/acting-session.server';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  return endActing(req);
}
