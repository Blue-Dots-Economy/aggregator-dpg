/**
 * Edge middleware — header injection only.
 *
 * Auth gating happens in `app/(protected)/layout.tsx` (Server Component, Node
 * runtime, full Redis access). The Edge runtime cannot import `ioredis`, so
 * we keep this layer minimal.
 *
 * Sets `x-pathname` on the request and the response, so layouts can build a
 * `returnTo` query param when redirecting unauthenticated users to /login, and
 * `callApi` can tell a console request from a coordinator-portal one.
 */

import { type NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname + req.nextUrl.search;
  // On the request for `headers()` in layouts and route handlers, replacing any
  // value the client sent; `callApi` relies on it to keep console calls out of acting mode.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-pathname', pathname);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('x-pathname', pathname);
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
