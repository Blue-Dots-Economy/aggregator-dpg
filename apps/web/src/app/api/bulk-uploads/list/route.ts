/**
 * BFF proxy: list bulk uploads (paginated).
 *   GET /api/bulk-uploads/list?limit=&offset=
 *
 * Sits at /list rather than the bare /api/bulk-uploads so it does not
 * collide with the create route on the same path.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../lib/upstream-client';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const qs = req.nextUrl.search;
    const upstream = await callApi(`/v1/bulk-uploads${qs}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    if (err instanceof Error && err.message === 'no active session') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json(
      { error: 'ServiceUnavailable', message: 'bulk-uploads service unavailable' },
      { status: 503 },
    );
  }
}

async function passthrough(upstream: Response): Promise<NextResponse> {
  const ct = upstream.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const data = (await upstream.json()) as unknown;
    return NextResponse.json(data, { status: upstream.status });
  }
  const text = await upstream.text();
  return new NextResponse(text, { status: upstream.status });
}
