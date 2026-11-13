/**
 * BFF proxy for the signalstack-backed aggregator dashboard CSV export.
 *
 *   GET /api/dashboard/export?domain=seeker&status=at_risk
 *
 * Forwards to the aggregator API's GET /v1/dashboard/export and returns the
 * CSV with the upstream `Content-Type` and `Content-Disposition` headers.
 * The query is checked with the API's rules and only its keys are forwarded.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/upstream-client';
import { passthrough, proxyFailureResponse } from '@/lib/bff-proxy';
import { parseQuery } from '@/lib/bff-input';

export const runtime = 'nodejs';

/** Same rules as the API's `DashboardExportQuerySchema`; `refresh` is forwarded as sent. */
const DashboardExportQuerySchema = z.object({
  domain: z.string().min(1).optional(),
  status: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_]+$/i)
    .optional(),
  refresh: z.string().optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const query = parseQuery(req.nextUrl.searchParams, DashboardExportQuerySchema);
  if (!query.ok) return query.response;
  try {
    const upstream = await callApi(`/v1/dashboard/export${query.search}`, {
      method: 'GET',
      // The API currently ignores this header.
      headers: { accept: 'text/csv' },
    });
    const ct = upstream.headers.get('content-type') ?? '';
    // Errors come back as JSON so the client can show a toast.
    if (!upstream.ok) return await passthrough(upstream);
    // Success: relay the CSV and keep the filename and charset.
    const body = await upstream.text();
    const headers: Record<string, string> = {
      'Content-Type': ct || 'text/csv; charset=utf-8',
    };
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) headers['Content-Disposition'] = disposition;
    return new NextResponse(body, { status: upstream.status, headers });
  } catch (err) {
    return proxyFailureResponse(err, 'dashboard-export');
  }
}
