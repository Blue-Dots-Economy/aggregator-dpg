/**
 * BFF proxy: onboarding metrics grouped by entry source.
 *   GET /api/onboarding/by-source?from=&to=
 *
 * Forwards to the aggregator API's GET /v1/onboarding/by-source.
 * Only `from` and `to` are forwarded, after the same checks the API applies.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyOnboardingRead } from '@/lib/onboarding-proxy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  return proxyOnboardingRead(req, '/v1/onboarding/by-source');
}
