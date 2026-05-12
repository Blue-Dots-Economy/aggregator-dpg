/**
 * BFF proxy: CSV template / sample download.
 *   GET /api/bulk-uploads/template?participant_type=seeker[&sample=10]
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../lib/upstream-client';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const qs = req.nextUrl.search;
    const upstream = await callApi(`/v1/bulk-uploads/template${qs}`, { method: 'GET' });
    if (!upstream.ok) {
      const text = await upstream.text();
      return new NextResponse(text || 'upstream error', { status: upstream.status });
    }
    const body = await upstream.text();
    const ct = upstream.headers.get('content-type') ?? 'text/csv; charset=utf-8';
    const cd = upstream.headers.get('content-disposition') ?? 'attachment; filename="template.csv"';
    return new NextResponse(body, {
      status: 200,
      headers: { 'Content-Type': ct, 'Content-Disposition': cd },
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'no active session') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json(
      { error: 'ServiceUnavailable', message: 'template service unavailable' },
      { status: 503 },
    );
  }
}
