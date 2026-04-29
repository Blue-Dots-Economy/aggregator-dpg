/**
 * Edge middleware — header injection only.
 *
 * Auth gating happens in `app/(protected)/layout.tsx` (Server Component, Node
 * runtime, full Redis access). The Edge runtime cannot import `ioredis`, so
 * we keep this layer minimal.
 *
 * Sets `x-pathname` so layouts can build a `returnTo` query param when
 * redirecting unauthenticated users to /login.
 */

import { type NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  res.headers.set('x-pathname', req.nextUrl.pathname + req.nextUrl.search);
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
