/**
 * Console BFF: an org owner adds their own coordinator account to My Team.
 *   POST /api/console/user/self-add → API POST /v1/user/self/add
 *
 * Guarded by `consoleMutation` (JSON body, same-origin) and sent with the
 * caller's own token. The upstream response passes through unchanged. On
 * success the cached console actor is dropped, so the next page shows the new
 * account ("Onboard participants", the "You" tag) without waiting for the cache.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { consoleMutation } from '@/lib/console-proxy';
import { SESSION_COOKIE } from '@/lib/cookies';
import { getSessionStore } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const res = await consoleMutation(req, {
    method: 'POST',
    path: '/v1/user/self/add',
    service: 'console',
  });
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  if (res.ok && sid) await getSessionStore().update(sid, { consoleActor: undefined });
  return res;
}
