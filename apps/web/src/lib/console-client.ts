/**
 * Browser-side caller of the console's BFF mutations.
 *
 * Sends same-origin JSON and returns the status and body instead of throwing,
 * so a view can update in place on `409 ALREADY_DECIDED`.
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
 * Returns the console message key for a failed call.
 *
 * @param r - A failed result.
 * @returns A key under `console.errors`.
 */
export function errorKey(r: { status: number; error: ConsoleError }): string {
  if (r.status === 429) return 'errors.rate_limited';
  if (r.status === 404) return 'errors.not_found';
  if (r.error.code === 'ORG_NAME_TAKEN') return 'errors.name_taken';
  if (r.error.code === 'ROLE_ASSIGNMENT_NOT_ALLOWED') return 'errors.role_not_allowed';
  const roleErrors: Record<string, string> = {
    ROLE_INVALID: 'errors.role_invalid',
    ROLE_EXISTS: 'errors.role_exists',
    ROLE_BUILTIN: 'errors.role_builtin',
    ROLE_IN_USE: 'errors.role_in_use',
    ROLE_LIMIT_REACHED: 'errors.role_limit',
  };
  if (r.error.code && roleErrors[r.error.code]) return roleErrors[r.error.code]!;
  const treeErrors: Record<string, string> = {
    ORG_DEPTH_LIMIT: 'errors.depth_limit',
    ORG_CHILD_LIMIT: 'errors.child_limit',
    ORG_TOTAL_LIMIT: 'errors.total_limit',
    ORG_PARENT_CYCLE: 'errors.parent_cycle',
    KNOWN_AS_DEPTH: 'errors.known_as_depth',
  };
  if (r.error.code && treeErrors[r.error.code]) return treeErrors[r.error.code]!;
  const fields = r.error.fields ?? {};
  if (r.error.code === 'CONFLICT') {
    if (fields['reason'] === 'busy') return 'errors.busy';
    if (fields['reason'] === 'not_movable') return 'errors.not_movable';
  }
  if (r.error.code === 'SCHEMA_VALIDATION') {
    if (fields['parent_id'] === 'invalid') return 'errors.parent_invalid';
    if (fields['known_as'] === 'invalid') return 'errors.known_as_invalid';
  }
  return 'errors.generic';
}
