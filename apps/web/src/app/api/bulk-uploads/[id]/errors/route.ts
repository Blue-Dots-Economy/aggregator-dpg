/**
 * BFF proxy: presigned errors.csv download.
 *   GET /api/bulk-uploads/:id/errors → API GET /v1/bulk-uploads/:id/errors.csv
 *
 * An id Postgres cannot read as a UUID answers 404 without calling the API.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { callApi } from '@/lib/upstream-client';
import { passthrough, proxyFailureResponse } from '@/lib/bff-proxy';
import { invalidIdResponse, isPostgresUuid } from '@/lib/bff-input';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!isPostgresUuid(id)) return invalidIdResponse();
  try {
    const upstream = await callApi(`/v1/bulk-uploads/${encodeURIComponent(id)}/errors.csv`, {
      method: 'GET',
    });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'bulk-uploads');
  }
}
