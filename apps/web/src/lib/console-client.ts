/**
 * Browser-side caller of the console's BFF mutations (user & org Phase 5).
 *
 * Sends JSON with the same-origin defaults the BFF guard expects, and returns
 * the status and body instead of throwing, so a view can update in place on
 * `409 ALREADY_DECIDED` (C10).
 *
 * @module apps/web/src/lib/console-client
 */

/** The API's error envelope, as far as the console reads it. */
export interface ConsoleError {
  code?: string;
  fields?: Record<string, unknown>;
}

export type ConsoleSendResult<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; error: ConsoleError };

/**
 * Calls a console BFF route.
 *
 * @param url - BFF path, e.g. `/api/console/user/decision/<id>`.
 * @param method - `POST` or `PATCH`.
 * @param body - JSON body.
 * @returns The outcome; never throws on an HTTP error.
 */
export async function sendConsole<T>(
  url: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<ConsoleSendResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: {} };
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (res.ok) return { ok: true, status: res.status, data: json as T };
  const error = (json as { error?: ConsoleError } | null)?.error;
  return { ok: false, status: res.status, error: typeof error === 'object' && error ? error : {} };
}

/**
 * The console message key for a failed call.
 *
 * @param r - A failed result.
 * @returns A key under `console.errors`.
 */
export function errorKey(r: { status: number; error: ConsoleError }): string {
  if (r.status === 429) return 'errors.rate_limited';
  if (r.status === 404) return 'errors.not_found';
  if (r.error.code === 'ORG_NAME_TAKEN') return 'errors.name_taken';
  if (r.error.code?.startsWith('PERMISSION_GRANT_')) return 'errors.grant_not_allowed';
  return 'errors.generic';
}
