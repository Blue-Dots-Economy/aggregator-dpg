/**
 * BFF proxy for registration links.
 *
 *   GET  /api/links?status=&limit=&offset=
 *   POST /api/links
 *
 * Forwards to the upstream API verbatim with the active session's bearer
 * token. Body and response shapes are not re-mapped here.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../lib/upstream-client';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const qs = req.nextUrl.search;
    const upstream = await callApi(`/v1/links${qs}`, { method: 'GET' });
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'BadRequest', message: 'invalid JSON' }, { status: 400 });
  }
  try {
    const upstream = await callApi('/v1/links/create', { method: 'POST', body });
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
