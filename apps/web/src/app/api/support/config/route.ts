/**
 * BFF proxy exposing whether contact-support is enabled.
 *
 *   GET /api/support/config
 *
 * Forwards to the aggregator API's `GET /v1/support/config`. The web app
 * hides "Contact support" when `enabled` is `false`.
 */

import { type NextResponse } from 'next/server';
import { callApi } from '@/lib/upstream-client';
import { passthrough, proxyFailureResponse } from '@/lib/bff-proxy';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const upstream = await callApi('/v1/support/config', { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'support');
  }
}
