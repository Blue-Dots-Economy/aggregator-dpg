/**
 * BFF route that records the terms accepted on the terms page.
 *
 *   POST /api/consent   { terms_version, privacy_version }
 *
 * Forwards to the API's `POST /v1/user/consent`. On 200 the session's terms
 * status becomes `ok`, so the portal and the API proxy open again. Any other
 * answer, such as 409 `CONSENT_VERSION_CHANGED`, is passed through and the
 * session is left as it was.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/upstream-client';
import { passthrough, proxyFailureResponse, readJsonBody } from '@/lib/bff-proxy';
import { rejectCrossSite } from '@/lib/same-origin';
import { storeTermsStatus } from '@/lib/terms-guard.server';

export const runtime = 'nodejs';

/** The versions of the documents the user read and accepted. */
const ConsentBodySchema = z
  .object({
    terms_version: z.number().int().positive(),
    privacy_version: z.number().int().positive(),
  })
  .strict();

/**
 * Records the caller's acceptance of the current terms and privacy policy.
 *
 * @param req - Same-origin JSON request with `terms_version` and `privacy_version`.
 * @returns The API's answer passed through; 400 for a malformed body, 403 for a cross-site request.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const refused = rejectCrossSite(req);
  if (refused) return refused;

  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  const parsed = ConsentBodySchema.safeParse(read.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'BadRequest', message: 'terms_version and privacy_version are required' },
      { status: 400 },
    );
  }

  try {
    const upstream = await callApi('/v1/user/consent', { method: 'POST', body: parsed.data });
    if (upstream.status === 200) await storeTermsStatus('ok');
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'consent');
  }
}
