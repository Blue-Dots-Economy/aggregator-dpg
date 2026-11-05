/**
 * Path and query checks for the web BFF's Route Handlers.
 *
 * A handler checks its path ids and query with these helpers before it calls
 * the API, and forwards only the query keys its schema names. Request bodies
 * are not checked here; the API validates them.
 *
 * @module apps/web/src/lib/bff-input
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

/** 32 hex digits with an optional hyphen after any group of four. */
const POSTGRES_UUID_BODY_RE = /^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i;

/**
 * Whether a path segment is a value Postgres accepts as a `uuid`.
 *
 * Accepts every text form Postgres's `uuid` type reads, optionally wrapped
 * in braces. The API looks these ids up in `uuid` columns, so any other
 * value fails upstream and never returns a row.
 *
 * @param id - The raw path segment.
 * @returns True when Postgres would read it as a UUID.
 */
export function isPostgresUuid(id: string): boolean {
  const body = id.startsWith('{') && id.endsWith('}') ? id.slice(1, -1) : id;
  return POSTGRES_UUID_BODY_RE.test(body);
}

/**
 * Builds the 400 response for a query the route's schema rejects.
 *
 * The body names no field and echoes no value.
 *
 * @returns A 400 JSON response with code `SCHEMA_VALIDATION`.
 */
export function invalidQueryResponse(): NextResponse {
  return NextResponse.json(
    { error: { code: 'SCHEMA_VALIDATION', title: 'Invalid query parameters' } },
    { status: 400 },
  );
}

/** A query schema: an object, optionally wrapped in a refinement. */
export type QuerySchema = z.AnyZodObject | z.ZodEffects<z.AnyZodObject>;

/** Outcome of {@link parseQuery}: the rebuilt search string, or a ready 400. */
export type QueryResult = { ok: true; search: string } | { ok: false; response: NextResponse };

/**
 * Checks a request's query against a schema and rebuilds the search string.
 *
 * Only the schema's keys are read, first value of each. They are forwarded
 * with their original text, so the API parses the same input it would get
 * directly. Other keys are dropped.
 *
 * @param params - The request's search params.
 * @param schema - The query schema; it should match the API route's schema.
 * @returns `{ ok: true, search }` (`''` or `?k=v…`), or `{ ok: false, response }`.
 */
export function parseQuery(params: URLSearchParams, schema: QuerySchema): QueryResult {
  const shape = schema instanceof z.ZodEffects ? schema.innerType().shape : schema.shape;
  const raw = new URLSearchParams();
  for (const key of Object.keys(shape)) {
    const value = params.get(key);
    if (value !== null) raw.set(key, value);
  }
  if (!schema.safeParse(Object.fromEntries(raw)).success) {
    return { ok: false, response: invalidQueryResponse() };
  }
  const search = raw.toString();
  return { ok: true, search: search ? `?${search}` : '' };
}
