/**
 * BFF proxy: list bulk uploads (paginated).
 *   GET /api/bulk-uploads/list?limit=&offset=
 *
 * Sits at /list rather than the bare /api/bulk-uploads so it does not
 * collide with the create route on the same path.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../lib/upstream-client';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const qs = req.nextUrl.search;
    const upstream = await callApi(`/v1/bulk-uploads${qs}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    if (err instanceof Error && err.message === 'no active session') {
      return NextResponse.json(
        {
          error: 'Unauthorized',
          code: 'NO_ACTIVE_SESSION',
          message:
            'No active session cookie was found, or your session has expired. Sign in again at /login and retry the request.',
          hint: 'The BFF requires a valid `sid` cookie; the upstream API call was not attempted.',
        },
        { status: 401 },
      );
    }
    const detail = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json(
      {
        error: 'ServiceUnavailable',
        code: 'BULK_UPLOADS_UPSTREAM_FAILED',
        message: 'The bulk-uploads service is temporarily unreachable. Please try again shortly.',
        detail,
      },
      { status: 503 },
    );
  }
}

async function passthrough(upstream: Response): Promise<NextResponse> {
  const ct = upstream.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const data = (await upstream.json()) as unknown;
    return NextResponse.json(data, { status: upstream.status });
  }
  const text = await upstream.text();
  return new NextResponse(text, { status: upstream.status });
}
