/**
 * Turns a failed shared-service result into an HTTP error (`@aggregator-dpg/api`).
 *
 * The registration services return results so operator tools can call them;
 * routes unwrap them with {@link unwrapOrThrow}.
 */

import { httpError } from './http-error.js';
import type { ErrorCode } from './codes.js';

/** A refusal a shared service returns; `code` is a key of the API error catalogue. */
export interface ServiceFailure {
  code: ErrorCode;
  /** Replaces the catalogue detail for this occurrence. */
  detail?: string;
  fields?: Record<string, unknown>;
  cause?: Error;
}

/**
 * Returns a successful service value, or throws its error as an HTTP error.
 *
 * @throws {HttpError} The error's code, detail, fields and cause.
 */
export function unwrapOrThrow<T>(
  result: { ok: true; value: T } | { ok: false; error: ServiceFailure },
): T {
  if (result.ok) return result.value;
  const { code, detail, fields, cause } = result.error;
  throw httpError(code, {
    ...(detail !== undefined ? { detail } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
}
