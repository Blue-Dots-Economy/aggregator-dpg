/**
 * Shared plumbing for the console's mutating BFF routes (user & org Phase 5).
 *
 * Every console mutation is a `POST` / `PATCH` that: refuses cross-site or
 * non-JSON requests ({@link rejectCrossSite}), validates the path id, reads the
 * JSON body, and forwards it with the caller's own token through `callApi`
 * (never the service token — see `apps/web/CLAUDE.md`). The upstream envelope
 * is passed through unchanged, so a `409 ALREADY_DECIDED` reaches the view.
 *
 * @module apps/web/src/lib/console-proxy
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from './upstream-client';
import { passthrough, proxyFailureResponse, readJsonBody } from './bff-proxy';
import { rejectCrossSite } from './same-origin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a path segment is a UUID (the only id shape the console APIs take).
 *
 * @param id - The raw segment.
 * @returns True for a UUID.
 */
export function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

/** Options of {@link consoleMutation}. */
export interface ConsoleMutationOptions {
  method: 'POST' | 'PATCH';
  /** Upstream path, already carrying a validated id. */
  path: string;
  /** Service label for the 503 code. */
  service: string;
}

/**
 * Runs one guarded console mutation.
 *
 * @param req - The incoming request.
 * @param opts - Method, upstream path, service label.
 * @returns The upstream response, or the guard's / proxy's error response.
 */
export async function consoleMutation(
  req: NextRequest,
  opts: ConsoleMutationOptions,
): Promise<NextResponse> {
  const refused = rejectCrossSite(req);
  if (refused) return refused;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  try {
    const upstream = await callApi(opts.path, { method: opts.method, body: body.body });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, opts.service);
  }
}

/** The 404 a malformed id answers (same as an id out of reach upstream). */
export function invalidIdResponse(): NextResponse {
  return NextResponse.json({ error: { code: 'NOT_FOUND', title: 'Not found' } }, { status: 404 });
}
