/**
 * Shared helpers for the admin approval routes (coordinator + org flows).
 *
 * Both `aggregator-approvals.ts` and `aggregator-org-approvals.ts` render the
 * same HTML result/confirm pages and map the same signed-token error codes to
 * user copy. This module holds the pieces that are byte-for-byte identical
 * across the two flows so they cannot drift. Belongs to `@aggregator-dpg/api`.
 *
 * @module apps/api/src/routes/approval-shared
 */

import type { FastifyReply } from 'fastify';

/** Signed approval-token verification failure codes surfaced to the reviewer. */
export type TokenErrorCode = 'EXPIRED' | 'INVALID' | 'MALFORMED';

/**
 * Sends an HTML page as a Fastify reply with the correct content type.
 *
 * @param reply - The Fastify reply to write to.
 * @param status - HTTP status code.
 * @param html - Rendered HTML body.
 * @returns The reply, for chaining/return.
 */
export function sendHtml(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply.status(status).type('text/html; charset=utf-8').send(html);
}

/**
 * Maps a token verification error code to user-facing copy for the result page.
 * The expired case points at the resend affordance both flows now render.
 *
 * @param code - The verification failure code.
 * @returns A single-sentence, reviewer-facing message.
 */
export function tokenErrorMessage(code: TokenErrorCode): string {
  switch (code) {
    case 'EXPIRED':
      return 'This approval link has expired. Use the resend option to get a fresh link.';
    case 'INVALID':
      return 'Approval link signature is invalid.';
    case 'MALFORMED':
    default:
      return 'Approval link is malformed.';
  }
}
