/**
 * BFF proxy for anonymous voice-bot requests.
 *
 * The caller is unauthenticated; the `(org, slug)` pair grants access.
 * Forwards the JSON body to `/public/v1/aggregators/:orgSlug/voice-requests/:slug`
 * with no Bearer or service token. The upstream status and body pass through,
 * and a `Retry-After` header is kept.
 *
 * POST /api/[org]/[slug]/voice-request
 */

import type { NextRequest, NextResponse } from 'next/server';
import { forwardJsonPost, type PublicLinkRouteContext } from '@/lib/public-proxy';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: PublicLinkRouteContext,
): Promise<NextResponse> {
  const { org, slug } = await params;
  return forwardJsonPost(req, {
    path: `/public/v1/aggregators/${encodeURIComponent(org)}/voice-requests/${encodeURIComponent(slug)}`,
    tooLargeTitle: 'Request too large',
    unavailableDetail: 'Could not reach the registration service.',
    passRetryAfter: true,
  });
}
