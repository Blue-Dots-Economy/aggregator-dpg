/**
 * BFF proxy for the voice bots a link can point to.
 *
 *   GET /api/links/voice-bots?domain=
 *
 * Forwards to the upstream API with the session's bearer token. The query is
 * checked against the API's schema and only its keys are forwarded.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/upstream-client';
import { passthrough, proxyFailureResponse } from '@/lib/bff-proxy';
import { parseQuery } from '@/lib/bff-input';

export const runtime = 'nodejs';

/** `domain` is required, as in the API's `GET /v1/links/voice-bots` query schema. */
const VoiceBotsQuerySchema = z.object({
  domain: z.string().min(1),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const query = parseQuery(req.nextUrl.searchParams, VoiceBotsQuerySchema);
  if (!query.ok) return query.response;
  try {
    const upstream = await callApi(`/v1/links/voice-bots${query.search}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'links');
  }
}
