/**
 * Client-side HTTP wrapper for BFF calls from the browser (web app).
 *
 * `jsonFetch` sets JSON headers, sends the session cookie, and logs the
 * user out on a 401 `NO_ACTIVE_SESSION` response (see `lib/bff-errors.ts`).
 * A failed call throws an {@link HttpError} carrying the API's error envelope.
 */

import { z } from 'zod';
import { parseResponseBody, ResponseShapeError } from '../lib/response-shape-error';

let redirecting = false;

/** The 401 body that `bff-errors.ts` sends when the session has expired. */
const SessionExpiredBodySchema = z.object({ code: z.literal('NO_ACTIVE_SESSION') });

/** A field that is kept only when it is a non-empty string. */
const optionalText = z.string().min(1).optional().catch(undefined);

const ErrorEnvelopeSchema = z.object({
  code: optionalText,
  title: optionalText,
  detail: optionalText,
  message: optionalText,
  requestId: optionalText,
  fields: z.record(z.unknown()).optional().catch(undefined),
});

/** API errors nest the envelope under `error`; some bodies are flat. */
const ErrorBodySchema = z.union([
  z
    .object({ error: ErrorEnvelopeSchema, code: optionalText })
    .transform(({ error, code }) => ({ ...error, code: error.code ?? code })),
  ErrorEnvelopeSchema,
]);

/** The envelope fields an {@link HttpError} carries. */
export interface HttpErrorEnvelope {
  code?: string;
  title?: string;
  detail?: string;
  /** The API's request id, quoted to support for a server fault. */
  requestId?: string;
  fields?: Record<string, unknown>;
}

/** Reads the constructor argument: an envelope, a bare `error.code`, or nothing. */
function asEnvelope(value: HttpErrorEnvelope | string | undefined): HttpErrorEnvelope {
  if (typeof value === 'string') return { code: value };
  return value ?? {};
}

/**
 * A failed BFF call, carrying the API's error envelope
 * (`{ error: { code, title, detail, fields } }`) so a view can pick a
 * readable message and map field errors. `status` is 0 for a network failure.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly title: string | undefined;
  readonly detail: string | undefined;
  readonly requestId: string | undefined;
  readonly fields: Record<string, unknown> | undefined;

  /**
   * @param status - The HTTP status; 0 when the request never reached the server.
   * @param envelope - The API's error envelope, or just its `error.code`.
   */
  constructor(status: number, envelope: HttpErrorEnvelope | string | undefined = {}) {
    // The status only, never the body, so the message is safe to log.
    super(`request failed (${status})`);
    const env = asEnvelope(envelope);
    this.name = 'HttpError';
    this.status = status;
    this.code = env.code;
    this.title = env.title;
    this.detail = env.detail;
    this.requestId = env.requestId;
    this.fields = env.fields;
  }
}

/** Reads `{ error: {...} }` or a flat `{ code, title, detail, fields }` body. */
function parseEnvelope(body: unknown): HttpErrorEnvelope {
  const parsed = ErrorBodySchema.safeParse(body);
  if (!parsed.success) return {};
  const { code, title, detail, message, requestId, fields } = parsed.data;
  const text = detail ?? message;
  return {
    ...(code ? { code } : {}),
    ...(title ? { title } : {}),
    ...(text ? { detail: text } : {}),
    ...(requestId ? { requestId } : {}),
    ...(fields ? { fields } : {}),
  };
}

/**
 * TanStack Query `retry` rule: one retry, but none for a `ResponseShapeError`,
 * which would fail the same way again.
 *
 * @param failureCount - Failures so far for this query.
 * @param error - The latest failure.
 */
export function retryUnlessShapeError(failureCount: number, error: unknown): boolean {
  return !(error instanceof ResponseShapeError) && failureCount < 1;
}

/** The request's URL, for logs. */
function urlOf(input: RequestInfo): string {
  return typeof input === 'string' ? input : input.url;
}

/** Redirects to logout. Runs once per page, even with concurrent 401s. */
function forceLogout(): void {
  if (redirecting) return;
  redirecting = true;
  if (typeof window === 'undefined') return;
  // Skip when already on the login flow.
  const path = window.location.pathname;
  if (path.startsWith('/login') || path.startsWith('/api/auth/')) {
    redirecting = false;
    return;
  }
  const ret = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/api/auth/logout?reason=expired&return=${ret}`;
}

/**
 * Fetches a BFF endpoint and parses the JSON response with `schema`.
 *
 * Redirects to logout when the server reports `NO_ACTIVE_SESSION`. Fields the
 * schema does not declare are dropped, unless the schema keeps them (`.passthrough()`).
 *
 * @param input - The request URL or object.
 * @param schema - The expected shape of an OK response body.
 * @param init - Extra fetch options; headers are merged.
 * @returns The parsed body.
 * @throws {HttpError} When the request fails or the response is not OK.
 * @throws {ResponseShapeError} When an OK body is not JSON or does not match `schema`.
 */
export async function jsonFetch<S extends z.ZodTypeAny>(
  input: RequestInfo,
  schema: S,
  init?: RequestInit,
): Promise<z.output<S>> {
  let res: Response;
  try {
    res = await fetch(input, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
      credentials: 'include',
    });
  } catch {
    console.warn('[http] request did not reach the server', { url: urlOf(input) });
    throw new HttpError(0);
  }

  if (res.status === 401) {
    // Log out only for the session-expired body; other 401s fall through as errors.
    const body: unknown = await res
      .clone()
      .json()
      .catch(() => null);
    if (SessionExpiredBodySchema.safeParse(body).success) {
      forceLogout();
      throw new HttpError(401, { code: 'NO_ACTIVE_SESSION' });
    }
  }

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const error = new HttpError(res.status, parseEnvelope(body));
    // Status, code and request id only: the body can hold the user's input.
    console.error('[http] request failed', {
      url: urlOf(input),
      status: error.status,
      code: error.code,
      requestId: error.requestId,
    });
    throw error;
  }

  return parseResponseBody(res, urlOf(input), schema);
}
