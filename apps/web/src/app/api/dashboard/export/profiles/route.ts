/**
 * BFF relay for the decrypted profile-data CSV export. Forwards the selected
 * item_ids to the aggregator API (which holds the signalstack admin key) and
 * streams the CSV (or JSON error envelope) back to the browser.
 *
 *   POST /api/dashboard/export/profiles
 *
 * The request body is forwarded verbatim to the aggregator API's
 * POST /v1/dashboard/export/profiles endpoint. Session cookie →
 * access token swap is handled by callApi. The CSV body is streamed
 * straight back to the browser with the upstream `Content-Type` and
 * `Content-Disposition` headers preserved so file-save dialogs receive
 * the same filename the API minted.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../../lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '../../../../../lib/bff-errors';

export const runtime = 'nodejs';

/**
 * Relays a profile-data CSV export request to the aggregator API and streams
 * the result back to the browser.
 *
 * @param req - Incoming POST request containing the JSON body with `item_ids` and `domain`.
 * @returns A NextResponse with the CSV payload or a JSON error envelope.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { message: 'invalid JSON body' } }, { status: 400 });
  }

  try {
    const upstream = await callApi('/v1/dashboard/export/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/csv' },
      body: JSON.stringify(body),
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
    const csv = await upstream.text();
    const headers: Record<string, string> = { 'Content-Type': ct || 'text/csv; charset=utf-8' };
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) headers['Content-Disposition'] = disposition;
    return new NextResponse(csv, { status: upstream.status, headers });
  } catch (err) {
    if (err instanceof Error && err.message === 'no active session') {
      return unauthorizedResponse();
    }
    return serviceUnavailableResponse(
      'dashboard-export-profiles',
      err instanceof Error ? err.message : undefined,
    );
  }
}
