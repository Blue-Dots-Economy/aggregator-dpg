/**
 * BFF proxy: deactivate a registration link.
 *   POST /api/links/:id/deactivate → API POST /v1/links/:id/deactivate
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../../lib/upstream-client';

export const runtime = 'nodejs';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    const upstream = await callApi(`/v1/links/${encodeURIComponent(id)}/deactivate`, {
      method: 'POST',
    });
    return await passthrough(upstream);
  } catch (err) {
    if (isNoSession(err)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json(
      { error: 'ServiceUnavailable', message: 'links service unavailable' },
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
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'Content-Type': ct || 'text/plain' },
  });
}

function isNoSession(err: unknown): boolean {
  return err instanceof Error && err.message === 'no active session';
}
