/**
 * BFF proxy: onboarding metrics summary.
 *   GET /api/onboarding/summary?from=&to=
 *
 * Only `from` and `to` are forwarded, after the same checks the API applies.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyOnboardingRead } from '@/lib/onboarding-proxy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  return proxyOnboardingRead(req, '/v1/onboarding/summary');
}
