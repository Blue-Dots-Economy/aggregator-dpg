/**
 * Shared helpers + types for the public registration surfaces.
 *
 * Both the coordinator form (`RegisterView`) and the org form
 * (`OrgRegisterForm`) render RJSF, POST to a BFF proxy, and surface the same
 * canonical error envelope. This module holds the pure logic they share:
 * humanising Ajv validation errors against schema titles and parsing the API
 * error envelope. Kept framework-free so it is trivially unit-testable.
 *
 * @module apps/web/src/app/(public)/register/registration-shared
 */

import type { RJSFSchema } from '@rjsf/utils';

/** Discriminated submit lifecycle shared by both registration forms. */
export type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'done'; refId: string }
  | { status: 'error'; title: string; detail: string; code: string; requestId: string };

/** Canonical API error envelope (partial — every field optional on the wire). */
export interface ApiErrorEnvelope {
  error?: {
    code?: string;
    title?: string;
    detail?: string;
    requestId?: string;
  };
}

/** Ajv-shaped validation error as surfaced by RJSF's `onError`. */
export interface AjvLikeError {
  name?: string;
  property?: string;
  message?: string;
  params?: Record<string, unknown>;
  schemaPath?: string;
}

/**
 * Title-cases a snake/kebab/dotted field key for a user-facing label.
 *
 * @param s - Raw field key (e.g. `owner.email`).
 * @returns Human-readable title (e.g. `Owner Email`).
 */
export function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\.([a-z])/gi, ' $1')
    .replace(/([A-Z])/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

/**
 * Walks a JSON Schema along a dotted path and returns the leaf node's `title`.
 *
 * @param schema - The JSON Schema to walk.
 * @param dottedPath - Dotted property path (e.g. `owner.email`).
 * @returns The leaf `title` if present, else `undefined`.
 */
export function lookupTitle(schema: RJSFSchema, dottedPath: string): string | undefined {
  if (!dottedPath) return undefined;
  const segs = dottedPath.split('.').filter(Boolean);
  let cur: unknown = schema;
  for (const seg of segs) {
    if (cur && typeof cur === 'object' && 'properties' in cur) {
      const props = (cur as { properties?: Record<string, unknown> }).properties;
      const next = props?.[seg];
      if (!next) return undefined;
      cur = next;
    } else {
      return undefined;
    }
  }
  if (cur && typeof cur === 'object' && 'title' in cur) {
    return (cur as { title?: string }).title;
  }
  return undefined;
}

/**
 * Converts Ajv-shaped validation errors into user-facing sentences keyed off
 * each field's schema `title` (falling back to a title-cased key, then the
 * raw message, then the schema path).
 *
 * @param errs - Raw Ajv errors from RJSF `onError`.
 * @param schema - The (pruned) schema the form validated against.
 * @returns De-duplicated, human-readable error lines (never empty).
 */
export function humaniseValidationErrors(errs: AjvLikeError[], schema: RJSFSchema): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of errs) {
    const propPath = (e.property ?? '').replace(/^\./, '');
    const missing = (e.params?.['missingProperty'] as string | undefined) ?? undefined;
    const fullPath = missing ? [propPath, missing].filter(Boolean).join('.') : propPath;
    const titleFromSchema = lookupTitle(schema, fullPath);
    const fallbackKey = missing || fullPath.split('.').pop() || '';
    const resolvedLabel =
      (titleFromSchema && titleFromSchema.trim()) || (fallbackKey && titleCase(fallbackKey)) || '';
    const isRequired = e.name === 'required' || /required/i.test(e.message ?? '');
    const rawMessage = (e.message ?? '').trim();
    let line: string;
    if (resolvedLabel) {
      line = isRequired
        ? `${resolvedLabel} is required`
        : `${resolvedLabel}: ${rawMessage || 'is invalid'}`;
    } else if (rawMessage) {
      line = rawMessage;
    } else {
      const where = (e.schemaPath ?? '').replace(/^#?\/?/, '');
      line = where ? `Validation failed at ${where}` : 'One or more fields failed validation.';
    }
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out.length > 0 ? out : ['One or more fields failed validation.'];
}

/**
 * Extracts a display-ready error from the canonical API envelope, applying
 * sensible fallbacks when the server response is missing fields.
 *
 * @param body - Parsed response body (may not be an envelope).
 * @param fallbackStatus - HTTP status, used to synthesise a detail line.
 * @param fallbackReqId - Request id to attribute when the body omits one.
 * @returns Normalised `{ title, detail, code, requestId }`.
 */
export function parseError(
  body: unknown,
  fallbackStatus: number,
  fallbackReqId: string,
): { title: string; detail: string; code: string; requestId: string } {
  const env = body as ApiErrorEnvelope;
  return {
    title: env?.error?.title ?? 'Submission failed',
    detail: env?.error?.detail ?? `The server returned HTTP ${fallbackStatus}.`,
    code: env?.error?.code ?? 'UNKNOWN',
    requestId: env?.error?.requestId ?? fallbackReqId,
  };
}

/**
 * Builds a consent object with `given_at` now and `valid_till` one year out,
 * merged over any existing consent fields on the form data.
 *
 * @param existing - The current `consent` sub-object from form data.
 * @returns Consent object with fresh timestamps stamped at call time.
 */
export function stampConsent(
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const now = new Date();
  const oneYear = new Date(now);
  oneYear.setFullYear(oneYear.getFullYear() + 1);
  return {
    ...(existing ?? {}),
    given_at: now.toISOString(),
    valid_till: oneYear.toISOString(),
  };
}
