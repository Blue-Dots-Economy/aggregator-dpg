/**
 * The error for a response body that does not match its schema (web app).
 * Used by the browser fetch wrapper and by server-side reads.
 */

import type { z } from 'zod';

/**
 * Thrown when an OK response body is not JSON or does not match the expected schema.
 *
 * TanStack Query surfaces it as the query's error state.
 */
export class ResponseShapeError extends Error {
  override readonly name = 'ResponseShapeError';

  /**
   * @param url - The request URL.
   * @param issues - The schema issues; empty when the body was not JSON.
   */
  constructor(
    readonly url: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(`unexpected response shape from ${url}`);
  }

  /**
   * Field path and issue code of each problem, for logs.
   *
   * Leaves out the received values, which can be personal data.
   */
  issueSummary(): { path: string; code: string }[] {
    return this.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code }));
  }
}
