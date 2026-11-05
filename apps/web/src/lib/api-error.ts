/**
 * Reads the `{ error: { code, detail, message } }` body of a failed API or BFF
 * response (web app). Safe in the browser and on the server.
 */

import { z } from 'zod';

/** A field that is kept only when it is a string. */
const optionalText = z.string().optional().catch(undefined);

const ApiErrorBodySchema = z.object({
  error: z.object({
    code: optionalText,
    detail: optionalText,
    message: optionalText,
  }),
});

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
 * @returns The string fields of `error`, or `null` when the body is not JSON or has no `error` object.
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
  const { code, detail, message } = parsed.data.error;
  return {
    ...(code !== undefined ? { code } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}
