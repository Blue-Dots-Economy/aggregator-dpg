/**
 * BFF proxy for aggregator profile read + update.
 *
 *   GET   /api/aggregator/profile/me
 *   PATCH /api/aggregator/profile/me  — partial update; body is split by the
 *                                       API into aggregator + profile writes
 *   PUT   /api/aggregator/profile/me  — legacy / full-replace alias kept for
 *                                       callers that haven't migrated yet
 *
 * Requires an active session — `callApi` attaches the access token and
 * refreshes it transparently. The body and response are forwarded verbatim;
 * the BFF never re-shapes the upstream contract.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../../../lib/bff-proxy';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const upstream = await callApi('/v1/aggregators/profile/me', { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'profile');
  }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'BadRequest', message: 'invalid JSON' }, { status: 400 });
  }
  try {
    const upstream = await callApi('/v1/aggregators/profile/me', {
      method: 'PATCH',
      body,
    });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'profile');
  }
}

// Legacy PUT alias — forwards to the API PATCH so older callers don't break.
export async function PUT(req: NextRequest): Promise<NextResponse> {
  return PATCH(req);
}
