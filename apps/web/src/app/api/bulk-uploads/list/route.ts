/**
 * BFF proxy: list bulk uploads (paginated).
 *   GET /api/bulk-uploads/list?limit=&offset=
 *
 * Lives at /list so it does not collide with the create route. Only `limit`
 * and `offset` are forwarded, after the same checks the API applies.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/upstream-client';
import { passthrough, proxyFailureResponse } from '@/lib/bff-proxy';
import { parseQuery } from '@/lib/bff-input';

export const runtime = 'nodejs';

/** Same rules as the API's `ListBulkUploadsQuerySchema`. */
const ListBulkUploadsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const query = parseQuery(req.nextUrl.searchParams, ListBulkUploadsQuerySchema);
  if (!query.ok) return query.response;
  try {
    const upstream = await callApi(`/v1/bulk-uploads${query.search}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'bulk-uploads');
  }
}
