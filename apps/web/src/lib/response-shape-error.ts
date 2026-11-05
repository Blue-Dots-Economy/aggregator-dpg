/**
 * The error for a response body that does not match its schema, and the
 * parser that throws it (web app). Used by the browser fetch wrapper and by
 * server-side reads.
 */

import type { z } from 'zod';

/** The field path and issue code of one schema problem. */
export interface IssueSummary {
  path: string;
  code: string;
}

/**
 * Field path and issue code of each schema problem, for logs.
 *
 * @param issues - The schema issues.
 * @returns One entry per issue. Leaves out the received values, which can be personal data.
 */
export function summariseIssues(issues: readonly z.ZodIssue[]): IssueSummary[] {
  return issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code }));
}

/**
 * Thrown when an OK response body is not JSON or does not match the expected schema.
 *
 * TanStack Query surfaces it as the query's error state. `issues` is not an
 * enumerable property, so printing the error does not show received values.
 */
export class ResponseShapeError extends Error {
  override readonly name = 'ResponseShapeError';

  /** The schema issues; empty when the body was not JSON. They can hold received values: never log them. */
  declare readonly issues: z.ZodIssue[];

  /**
   * @param url - The request URL.
   * @param issues - The schema issues; empty when the body was not JSON.
   */
  constructor(
    readonly url: string,
    issues: z.ZodIssue[],
  ) {
    super(`unexpected response shape from ${url}`);
    Object.defineProperty(this, 'issues', { value: issues, enumerable: false });
  }

  /**
   * Field path and issue code of each problem, for logs.
   *
   * Leaves out the received values, which can be personal data.
   */
  issueSummary(): IssueSummary[] {
    return summariseIssues(this.issues);
  }
}

/**
 * Reads a response body as JSON and checks it with a schema.
 *
 * @param res - The response. Its body is consumed.
 * @param url - The request URL, for the error.
 * @param schema - The expected body.
 * @returns The schema's output.
 * @throws {ResponseShapeError} When the body is not JSON or does not match.
 */
export async function parseResponseBody<S extends z.ZodTypeAny>(
  res: Response,
  url: string,
  schema: S,
): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ResponseShapeError(url, []);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ResponseShapeError(url, parsed.error.issues);
  return parsed.data;
}
