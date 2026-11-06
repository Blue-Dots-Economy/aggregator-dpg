/**
 * BFF proxy: bulk-upload template download (CSV or XLSX).
 *   GET /api/bulk-uploads/template?participant_type=seeker[&format=xlsx]
 *
 * Only `participant_type` and `format` are forwarded, after the same checks
 * the API applies; the API checks the participant type against the network.
 * The body is forwarded as bytes, not text, so XLSX workbooks are not corrupted.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '@/lib/bff-errors';
import { parseQuery } from '@/lib/bff-input';

export const runtime = 'nodejs';

/** Same rules as the API's `TemplateQuerySchema`. */
const TemplateQuerySchema = z.object({
  participant_type: z.string().optional(),
  format: z.enum(['csv', 'xlsx']).optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const query = parseQuery(req.nextUrl.searchParams, TemplateQuerySchema);
  if (!query.ok) return query.response;
  try {
    const upstream = await callApi(`/v1/bulk-uploads/template${query.search}`, { method: 'GET' });
    if (!upstream.ok) {
      const text = await upstream.text();
      return new NextResponse(text || 'upstream error', { status: upstream.status });
    }
    const body = await upstream.arrayBuffer();
    const ct = upstream.headers.get('content-type') ?? 'text/csv; charset=utf-8';
    const cd = upstream.headers.get('content-disposition') ?? 'attachment; filename="template.csv"';
    return new NextResponse(body, {
      status: 200,
      headers: { 'Content-Type': ct, 'Content-Disposition': cd },
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'no active session') {
      return unauthorizedResponse();
    }
    return serviceUnavailableResponse(
      'bulk-uploads-template',
      err instanceof Error ? err.message : undefined,
    );
  }
}
