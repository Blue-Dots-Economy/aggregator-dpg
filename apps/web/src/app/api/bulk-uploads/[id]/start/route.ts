/**
 * BFF proxy: confirm bulk upload completion.
 *   POST /api/bulk-uploads/:id/start → API POST /v1/bulk-uploads/:id/start
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { callApi } from '../../../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../../../lib/bff-proxy';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    // Forward the JSON body (carries the operator `attestation` flag) to the
    // API, which validates + records it before enqueueing (#522 Task 1).
    // Pass a parsed object — callApi JSON.stringifies it (passing a string
    // would double-encode and the API would see a string, not an object).
    const body = (await req.json().catch(() => ({}))) as unknown;
    const upstream = await callApi(`/v1/bulk-uploads/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      body: body ?? {},
    });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'bulk-uploads');
  }
}
