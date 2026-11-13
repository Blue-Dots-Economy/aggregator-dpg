/**
 * BFF proxy for registration links.
 *
 *   GET  /api/links?status=&limit=&offset=
 *   POST /api/links
 *
 * Forwards to the upstream API with the session's bearer token. The GET query
 * is checked against the API's list schema and only its keys are forwarded.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/upstream-client';
import { passthrough, proxyFailureResponse } from '@/lib/bff-proxy';
import { parseQuery } from '@/lib/bff-input';

export const runtime = 'nodejs';

/** Same rules as the API's `GET /v1/links` query schema (`ListQuerySchema`). */
const ListLinksQuerySchema = z.object({
  status: z.enum(['draft', 'live', 'retired']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const query = parseQuery(req.nextUrl.searchParams, ListLinksQuerySchema);
  if (!query.ok) return query.response;
  try {
    const upstream = await callApi(`/v1/links${query.search}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'links');
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'BadRequest', message: 'invalid JSON' }, { status: 400 });
  }
  try {
    const upstream = await callApi('/v1/links/create', { method: 'POST', body });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'links');
  }
}
