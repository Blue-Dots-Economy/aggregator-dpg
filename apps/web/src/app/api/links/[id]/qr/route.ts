/**
 * BFF proxy: mint a short-lived presigned QR download URL.
 *   GET /api/links/:id/qr → API GET /v1/links/:id/qr
 *
 * Proxied per click rather than embedded in the links list, so the URL the
 * browser follows is seconds old and no presigned URL is ever serialised into
 * a collection response.
 *
 * The api sets `cache-control: no-store` on its response, but `passthrough()`
 * rebuilds the body with NextResponse.json and copies only the status — so the
 * header is re-applied here. The payload carries a short-lived presigned URL: a
 * cached response would hand a client a dead URL and defeat the point of
 * minting per click.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { callApi } from '../../../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../../../lib/bff-proxy';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    const upstream = await callApi(`/v1/links/${encodeURIComponent(id)}/qr`, { method: 'GET' });
    const res = await passthrough(upstream);
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (err) {
    return proxyFailureResponse(err, 'links');
  }
}
