/**
 * Browser-side caller of the console's BFF mutations.
 *
 * Sends same-origin JSON and returns the status and body instead of throwing,
 * so a view can update in place on `409 ALREADY_DECIDED`.
 *
 * @module apps/web/src/lib/console-client
 */

import type {
  KnownAsValues,
  KnownAsValuesRequest,
  Org,
  OrgKnownAsUpdateRequest,
} from '@aggregator-dpg/shared-primitives/user-org';
import { z } from 'zod';
import { parseResponseBody, ResponseShapeError } from './response-shape-error';

/** The fields of the API's error envelope that the console reads. A field of the wrong type is dropped. */
const ConsoleErrorSchema = z.object({
  code: z.string().optional().catch(undefined),
  fields: z.record(z.unknown()).optional().catch(undefined),
});

/** The API's error envelope, as far as the console reads it. */
export type ConsoleError = z.infer<typeof ConsoleErrorSchema>;

const ConsoleErrorBodySchema = z.object({ error: ConsoleErrorSchema });

/** The error code a view gets when an OK body does not match its schema. */
export const RESPONSE_SHAPE_CODE = 'RESPONSE_SHAPE';

export type ConsoleSendResult<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; error: ConsoleError };

/**
 * Reads the error envelope of a failed console response body.
 *
 * @param body - The parsed body, or `null` when it was not JSON.
 * @returns The code and fields; empty when the body has no error object.
 */
function readConsoleError(body: unknown): ConsoleError {
  const parsed = ConsoleErrorBodySchema.safeParse(body);
  if (!parsed.success) return {};
  const { code, fields } = parsed.data.error;
  return { ...(code !== undefined ? { code } : {}), ...(fields !== undefined ? { fields } : {}) };
}

/**
 * Reads a response body as JSON.
 *
 * @returns The body, or `null` when it is not JSON.
 */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

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
  const json = await readJson(res);
  if (res.ok) return { ok: true, status: res.status, data: json as T };
  return { ok: false, status: res.status, error: readConsoleError(json) };
}

/**
 * Reads a console BFF route and checks the body with a schema.
 *
 * @param url - BFF path, e.g. `/api/console/org/parent/options/<id>`.
 * @param schema - The expected OK body.
 * @returns The outcome; an OK body that does not match gives the `RESPONSE_SHAPE` error code. Never throws.
 */
export async function getConsole<S extends z.ZodTypeAny>(
  url: string,
  schema: S,
): Promise<ConsoleSendResult<z.output<S>>> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin' });
  } catch {
    return { ok: false, status: 0, error: {} };
  }
  if (!res.ok)
    return { ok: false, status: res.status, error: readConsoleError(await readJson(res)) };
  try {
    return { ok: true, status: res.status, data: await parseResponseBody(res, url, schema) };
  } catch (err) {
    if (!(err instanceof ResponseShapeError)) throw err;
    console.error('[console] unexpected response shape', { url, issues: err.issueSummary() });
    return { ok: false, status: res.status, error: { code: RESPONSE_SHAPE_CODE } };
  }
}

/**
 * Sets an organisation's "known as" value (owner of its parent).
 *
 * @param orgId - The organisation.
 * @param knownAs - A key from the choices of the org's parent (`knownAsChoices`).
 * @returns The outcome, with the updated org on success.
 */
export function setOrgKnownAs(orgId: string, knownAs: string): Promise<ConsoleSendResult<Org>> {
  const body: OrgKnownAsUpdateRequest = { known_as: knownAs };
  return sendConsole<Org>(`/api/console/org/known-as/${orgId}`, 'PATCH', body);
}

/**
 * Replaces the "known as" values an organisation defines for its direct
 * children (its owner, or the network admin for the root).
 *
 * @param orgId - The organisation that defines the list.
 * @param values - The full list; saved entries keep their key, new ones omit it.
 * @returns The outcome, with the updated org and the saved list (keys filled) on success.
 */
export function setOrgKnownAsValues(
  orgId: string,
  values: KnownAsValuesRequest,
): Promise<ConsoleSendResult<Org & { known_as_values: KnownAsValues }>> {
  const body: OrgKnownAsUpdateRequest = { known_as_values: values };
  return sendConsole<Org & { known_as_values: KnownAsValues }>(
    `/api/console/org/known-as/${orgId}`,
    'PATCH',
    body,
  );
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
  };
  if (r.error.code && treeErrors[r.error.code]) return treeErrors[r.error.code]!;
  const fields = r.error.fields ?? {};
  if (r.error.code === 'CONFLICT') {
    if (fields['reason'] === 'busy') return 'errors.busy';
    if (fields['reason'] === 'not_movable') return 'errors.not_movable';
    if (fields['reason'] === 'moved') return 'errors.org_moved';
  }
  if (r.error.code === 'SCHEMA_VALIDATION') {
    if (fields['parent_id'] === 'invalid') return 'errors.parent_invalid';
    if (fields['known_as'] === 'invalid') return 'errors.known_as_invalid';
    if (fields['known_as_values'] === 'unknown_key') return 'errors.known_as_values_changed';
  }
  if (r.status === 0) return 'errors.network';
  if (r.status === 401) return 'errors.signed_out';
  if (r.status === 403) return 'errors.forbidden';
  if (r.status >= 500) return 'errors.server';
  return 'errors.generic';
}
