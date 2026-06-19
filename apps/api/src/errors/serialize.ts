/**
 * Serializes errors into the canonical wire envelope and the structured log
 * payload. Single source of truth for what reaches the client and what
 * reaches the log stream.
 */

import { ERR } from './codes.js';
import { HttpError } from './http-error.js';

export interface ErrorEnvelope {
  error: {
    code: string;
    title: string;
    detail: string;
    docs?: string;
    fields?: Record<string, unknown>;
    requestId: string;
    timestamp: string;
  };
}

export interface ErrorLogPayload {
  code: string;
  status: number;
  title: string;
  hint: string;
  cause?: string;
  stack?: string;
  fields?: Record<string, unknown>;
}

/**
 * Builds the response body sent to the client.
 *
 * `hint` and `stack` are NEVER included — those are log-only.
 */
export function toEnvelope(err: HttpError, requestId: string): ErrorEnvelope {
  const body: ErrorEnvelope['error'] = {
    code: err.code,
    title: err.title,
    detail: err.detail,
    requestId,
    timestamp: new Date().toISOString(),
  };
  if (err.docs !== undefined) body.docs = err.docs;
  if (err.fields !== undefined) body.fields = err.fields;
  return { error: body };
}

/**
 * Builds the structured log fields. Always includes `hint`. Includes `stack`
 * outside production. `cause` flattened to a string.
 */
export function toLogPayload(err: HttpError, includeStack: boolean): ErrorLogPayload {
  const payload: ErrorLogPayload = {
    code: err.code,
    status: err.status,
    title: err.title,
    hint: err.hint,
  };
  if (err.cause !== undefined) payload.cause = String(err.cause);
  if (includeStack && err.stack !== undefined) payload.stack = err.stack;
  if (err.fields !== undefined) payload.fields = err.fields;
  return payload;
}

/**
 * Coerces any thrown value into an HttpError so the handler has a uniform
 * shape to work with. Unknown errors collapse to ERR.INTERNAL with the
 * original error preserved as `cause`.
 */
export function coerceToHttpError(value: unknown): HttpError {
  if (value instanceof HttpError) return value;
  if (value instanceof Error) {
    return new HttpError(ERR.INTERNAL, { cause: value });
  }
  return new HttpError(ERR.INTERNAL, { cause: value });
}
