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

/** Message keys for error codes that need no more detail. */
const CODE_KEYS: Readonly<Record<string, string>> = {
  ORG_NAME_TAKEN: 'errors.name_taken',
  ROLE_ASSIGNMENT_NOT_ALLOWED: 'errors.role_not_allowed',
  ROLE_INVALID: 'errors.role_invalid',
  ROLE_EXISTS: 'errors.role_exists',
  ROLE_BUILTIN: 'errors.role_builtin',
  ROLE_IN_USE: 'errors.role_in_use',
  ROLE_LIMIT_REACHED: 'errors.role_limit',
  ORG_DEPTH_LIMIT: 'errors.depth_limit',
  ORG_CHILD_LIMIT: 'errors.child_limit',
  ORG_TOTAL_LIMIT: 'errors.total_limit',
  ORG_PARENT_CYCLE: 'errors.parent_cycle',
  KNOWN_AS_DEPTH: 'errors.known_as_depth',
};

/** Message keys for error codes that name the cause in `fields`, as `[field, value, key]`. */
const FIELD_KEYS: Readonly<Record<string, ReadonlyArray<readonly [string, string, string]>>> = {
  CONFLICT: [
    ['reason', 'busy', 'errors.busy'],
    ['reason', 'not_movable', 'errors.not_movable'],
  ],
  SCHEMA_VALIDATION: [
    ['parent_id', 'invalid', 'errors.parent_invalid'],
    ['known_as', 'invalid', 'errors.known_as_invalid'],
  ],
};

/** The message key for an HTTP status with no more specific message. */
function statusKey(status: number): string {
  if (status === 0) return 'errors.network';
  if (status === 401) return 'errors.signed_out';
  if (status === 403) return 'errors.forbidden';
  if (status >= 500) return 'errors.server';
  return 'errors.generic';
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
  const code = r.error.code ?? '';
  const byCode = CODE_KEYS[code];
  if (byCode) return byCode;
  const fields = r.error.fields ?? {};
  const byField = FIELD_KEYS[code]?.find(([field, value]) => fields[field] === value);
  if (byField) return byField[2];
  return statusKey(r.status);
}
