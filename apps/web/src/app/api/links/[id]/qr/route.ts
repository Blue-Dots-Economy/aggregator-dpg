/**
 * BFF proxy: mint a short-lived presigned QR download URL.
 *   GET /api/links/:id/qr → API GET /v1/links/:id/qr
 *
 * Proxied per click rather than embedded in the links list, so the URL the
 * browser follows is seconds old and no presigned URL is ever serialised into
 * a collection response.
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
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'links');
  }
}
