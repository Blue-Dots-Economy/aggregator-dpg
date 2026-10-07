/**
 * CSRF guard for the console's mutating BFF routes (user & org Phase 5, C11).
 *
 * Session cookies are `SameSite=Lax`, which still lets a top-level cross-site
 * form POST carry them. Console mutations therefore require a JSON body (a
 * cross-site form cannot send `application/json` without a CORS preflight the
 * BFF never answers) AND a same-origin `Origin` header — or, when a browser
 * omits `Origin`, `Sec-Fetch-Site: same-origin`. Nothing in the console
 * mutates on GET.
 *
 * @module apps/web/src/lib/same-origin
 */

import { type NextRequest, NextResponse } from 'next/server';

/**
 * The origin the portal is served from: `PUBLIC_PORTAL_URL`'s origin when set
 * (inside docker `req.nextUrl.origin` is the container bind address), else the
 * request's own origin.
 *
 * @param req - The incoming request.
 * @returns The expected origin, e.g. `https://portal.example.org`.
 */
export function expectedOrigin(req: NextRequest): string {
  const configured = process.env.PUBLIC_PORTAL_URL;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // A malformed PUBLIC_PORTAL_URL falls back to the request origin.
    }
  }
  return req.nextUrl.origin;
}

/**
 * Refuses a cross-site or non-JSON mutation.
 *
 * @param req - The incoming request.
 * @returns `null` when the request may proceed, else the 403 / 415 response.
 */
export function rejectCrossSite(req: NextRequest): NextResponse | null {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return NextResponse.json(
      { error: { code: 'UNSUPPORTED_MEDIA_TYPE', title: 'JSON body required' } },
      { status: 415 },
    );
  }
  const origin = req.headers.get('origin');
  const sameOrigin = origin
    ? origin === expectedOrigin(req)
    : req.headers.get('sec-fetch-site') === 'same-origin';
  if (!sameOrigin) {
    return NextResponse.json(
      { error: { code: 'CROSS_SITE_REJECTED', title: 'Request refused' } },
      { status: 403 },
    );
  }
  return null;
}
