/**
 * Server-side reads for the console pages.
 *
 * Reads use the user's own token (`callApi`). A search is a `POST` upstream
 * but counts as a read here. Failures navigate: no session goes to login, a
 * lost entitlement signs out with a reason, out of reach is a 404.
 *
 * @module apps/web/src/lib/console-api.server
 */

import { notFound, redirect } from 'next/navigation';
import type { z } from 'zod';
import { readApiError } from './api-error';
import { logger } from './logger';
import { ResponseShapeError } from './response-shape-error';
import { callApi } from './upstream-client';

/**
 * Parses an OK console response with its schema.
 *
 * @param res - The OK response. Its body is consumed.
 * @param path - Upstream path, for the error.
 * @param schema - The expected body.
 * @returns The schema's output.
 * @throws {ResponseShapeError} When the body is not JSON or does not match.
 */
async function parseBody<S extends z.ZodTypeAny>(
  res: Response,
  path: string,
  schema: S,
): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ResponseShapeError(path, []);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ResponseShapeError(path, parsed.error.issues);
  return parsed.data;
}

/**
 * Reads one console API resource, or navigates away.
 *
 * @param path - Upstream path, e.g. `/v1/org/read/<id>`.
 * @param schema - The expected response body.
 * @param body - When set, the read is a `POST` with this JSON body (search).
 * @returns The schema's output.
 * @throws Navigation (redirect / notFound) on failure, as Next.js does.
 * @throws {ResponseShapeError} When an OK body does not match `schema`.
 */
export async function consoleRead<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.output<S>> {
  let res: Response;
  try {
    res = await callApi(path, body === undefined ? { method: 'GET' } : { method: 'POST', body });
  } catch {
    redirect('/api/auth/login?returnTo=/console');
  }
  if (res.status === 401) redirect('/api/auth/login?returnTo=/console');
  if (res.status === 404) notFound();
  if (res.status === 403) {
    const code = (await readApiError(res))?.code;
    if (code === 'USER_NOT_PROVISIONED')
      redirect('/api/auth/logout?reason=console_not_provisioned');
    if (code === 'NOT_ORG_ADMIN') redirect('/api/auth/logout?reason=console_no_org');
    // Route not available to this actor: back to the console home.
    redirect('/console');
  }
  if (!res.ok) throw new Error(`console read failed (${res.status})`);
  try {
    return await parseBody(res, path, schema);
  } catch (err) {
    if (err instanceof ResponseShapeError) {
      logger.error({
        operation: 'consoleRead',
        status: 'failure',
        path,
        error: err.message,
        issues: err.issueSummary(),
      });
    }
    throw err;
  }
}

/**
 * Reads an optional console resource, returning null on any failure.
 *
 * For panels that are hidden when unavailable, e.g. RBAC grants when access
 * control is off (503) or the caller lacks the capability (403).
 *
 * @param path - Upstream path.
 * @param schema - The expected response body.
 * @returns The schema's output, or null.
 */
export async function consoleReadOptional<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
): Promise<z.output<S> | null> {
  try {
    const res = await callApi(path, { method: 'GET' });
    if (!res.ok) return null;
    return await parseBody(res, path, schema);
  } catch (err) {
    if (err instanceof ResponseShapeError) {
      logger.warn({
        operation: 'consoleReadOptional',
        status: 'failure',
        path,
        error: err.message,
        issues: err.issueSummary(),
      });
    }
    return null;
  }
}
