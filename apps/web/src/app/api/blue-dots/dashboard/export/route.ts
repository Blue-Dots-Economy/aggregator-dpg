/**
 * BFF proxy for the signalstack-backed aggregator dashboard CSV export.
 *
 *   GET /api/blue-dots/dashboard/export?domain=seeker&status=at_risk
 *
 * Forwards verbatim to the aggregator API's
 * GET /v1/blue-dots/dashboard/export endpoint. Session cookie →
 * access token swap is handled by callApi. The CSV body is streamed
 * straight back to the browser with the upstream `Content-Type` and
 * `Content-Disposition` headers preserved so file-save dialogs receive
 * the same filename the API minted.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../../lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '../../../../../lib/bff-errors';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const search = req.nextUrl.searchParams.toString();
  const path = `/v1/blue-dots/dashboard/export${search ? `?${search}` : ''}`;
  try {
    const upstream = await callApi(path, {
      method: 'GET',
      // Signal to the API route that the caller wants CSV. The API ignores
      // the header today but forwarding it future-proofs the contract.
      headers: { accept: 'text/csv' },
    });
    const ct = upstream.headers.get('content-type') ?? '';
    // Non-2xx responses come back as JSON error envelopes — surface them
    // as JSON to the caller so the web service can render a toast.
    if (!upstream.ok) {
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
    // 2xx CSV path — relay the body and preserve filename/charset.
    const body = await upstream.text();
    const headers: Record<string, string> = {
      'Content-Type': ct || 'text/csv; charset=utf-8',
    };
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) headers['Content-Disposition'] = disposition;
    return new NextResponse(body, { status: upstream.status, headers });
  } catch (err) {
    if (err instanceof Error && err.message === 'no active session') {
      return unauthorizedResponse();
    }
    return serviceUnavailableResponse(
      'blue-dots-dashboard-export',
      err instanceof Error ? err.message : undefined,
    );
  }
}
