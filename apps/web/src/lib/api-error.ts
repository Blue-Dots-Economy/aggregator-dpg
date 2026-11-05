/**
 * Reads the error body of a failed API or BFF response (web app). Safe in the
 * browser and on the server.
 *
 * The API sends `{ error: { code, detail, message } }`. The BFF's own errors
 * (`lib/bff-errors.ts`) send `{ error: <label>, code, message }`.
 */

import { z } from 'zod';

/** A field that is kept only when it is a string. */
const optionalText = z.string().optional().catch(undefined);

/**
 * The fields of an API error object that the web app reads. A field of the
 * wrong type is dropped.
 */
const ErrorFieldsSchema = z.object({
  code: optionalText,
  title: optionalText,
  detail: optionalText,
  message: optionalText,
  requestId: optionalText,
  fields: z.record(z.unknown()).optional().catch(undefined),
});

/** The API's error envelope: the fields nested under `error`. */
const ErrorEnvelopeSchema = z.object({ error: ErrorFieldsSchema });

/** API errors nest the fields; BFF errors put them beside a text `error` label. */
const ApiErrorBodySchema = z.union([
  ErrorEnvelopeSchema.transform((body) => body.error),
  ErrorFieldsSchema.extend({ error: z.string() }),
]);

/** The API error envelope, as far as the web app reads it. */
export type ErrorEnvelope = z.infer<typeof ErrorFieldsSchema>;

/**
 * Reads the error object of a parsed error body (`{ error: { code, title, detail, message, requestId, fields } }`).
 *
 * @param body - The parsed body; any value is accepted.
 * @returns The fields that have the right type; empty when the body has no error object.
 */
export function readErrorEnvelope(body: unknown): ErrorEnvelope {
  const parsed = ErrorEnvelopeSchema.safeParse(body);
  return parsed.success ? parsed.data.error : {};
}

/** The readable parts of an API error body. */
export interface ApiError {
  code?: string;
  detail?: string;
  message?: string;
}

/**
 * Reads the error object of a failed response.
 *
 * @param res - The failed response. Its body is consumed.
 * @returns The string fields, or `null` when the body is not JSON or has no `error`.
 */
export async function readApiError(res: Response): Promise<ApiError | null> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const parsed = ApiErrorBodySchema.safeParse(body);
  if (!parsed.success) return null;
  const { code, detail, message } = parsed.data;
  return {
    ...(code !== undefined ? { code } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * Text to show for a failed response: the error's detail, else its message, else `fallback`.
 *
 * @param res - The failed response. Its body is consumed.
 * @param fallback - Text used when the body has neither.
 */
export async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  const error = await readApiError(res);
  return error?.detail ?? error?.message ?? fallback;
}
