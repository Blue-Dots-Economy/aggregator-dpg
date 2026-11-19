/**
 * BFF proxy for anonymous participant submissions.
 *
 * The caller is unauthenticated; the `(org, slug)` pair grants access.
 * Forwards the JSON body to `/public/v1/aggregators/:orgSlug/registrations/:slug`
 * with no Bearer or service token.
 *
 * POST /api/[org]/[slug]/submit
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
    path: `/public/v1/aggregators/${encodeURIComponent(org)}/registrations/${encodeURIComponent(slug)}`,
    tooLargeTitle: 'Submission too large',
    unavailableDetail: 'Could not reach the registration service.',
  });
}
