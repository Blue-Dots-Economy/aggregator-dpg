/**
 * BFF proxy: deactivate a registration link.
 *   POST /api/links/:id/deactivate → API POST /v1/links/:id/deactivate
 *
 * An id Postgres cannot read as a UUID answers 404 without calling the API.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { callApi } from '@/lib/upstream-client';
import { passthrough, proxyFailureResponse } from '@/lib/bff-proxy';
import { invalidIdResponse, isPostgresUuid } from '@/lib/bff-input';

export const runtime = 'nodejs';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!isPostgresUuid(id)) return invalidIdResponse();
  try {
    const upstream = await callApi(`/v1/links/${encodeURIComponent(id)}/deactivate`, {
      method: 'POST',
    });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'links');
  }
}
