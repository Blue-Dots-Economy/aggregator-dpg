/**
 * Classifies a failed browser request (`apps/web`) so a view can show one
 * plain-language message instead of raw HTTP text.
 *
 * @module apps/web/src/lib/request-errors
 */

import { HttpError } from '../services/http';

/** Kinds of request failure, each with a `form.request_error.<kind>` message. */
export type RequestErrorKind =
  | 'network'
  | 'signed_out'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'too_large'
  | 'invalid'
  | 'server'
  | 'generic';

/**
 * Picks the message kind for a failed request.
 *
 * @param err - What the request threw, or an HTTP status.
 * @returns The message kind.
 */
export function requestErrorKind(err: unknown): RequestErrorKind {
  const status = typeof err === 'number' ? err : err instanceof HttpError ? err.status : undefined;
  if (status === undefined) return err instanceof TypeError ? 'network' : 'generic';
  if (status === 0) return 'network';
  if (status === 401) return 'signed_out';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'invalid';
  if (status >= 500) return 'server';
  return 'generic';
}

/**
 * The API's field errors from a failed request, if it sent any.
 *
 * @param err - What the request threw.
 * @returns `error.fields`, or `undefined`.
 */
export function requestErrorFields(err: unknown): Record<string, unknown> | undefined {
  return err instanceof HttpError ? err.fields : undefined;
}

/**
 * The API error code from a failed request, if any.
 *
 * @param err - What the request threw.
 * @returns `error.code`, or `undefined`.
 */
export function requestErrorCode(err: unknown): string | undefined {
  return err instanceof HttpError ? err.code : undefined;
}
