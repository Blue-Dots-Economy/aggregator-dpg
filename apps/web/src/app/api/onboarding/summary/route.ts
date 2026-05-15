/**
 * BFF proxy: onboarding metrics summary.
 *   GET /api/onboarding/summary?from=&to=
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '../../../../lib/bff-errors';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const qs = req.nextUrl.search;
    const upstream = await callApi(`/v1/onboarding/summary${qs}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    if (isNoSession(err)) {
      return unauthorizedResponse();
    }
    return serviceUnavailableResponse('onboarding', err instanceof Error ? err.message : undefined);
  }
}

async function passthrough(upstream: Response): Promise<NextResponse> {
  const ct = upstream.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const data = (await upstream.json()) as unknown;
    return NextResponse.json(data, { status: upstream.status });
  }
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'Content-Type': ct || 'text/plain' },
  });
}

function isNoSession(err: unknown): boolean {
  return err instanceof Error && err.message === 'no active session';
}
