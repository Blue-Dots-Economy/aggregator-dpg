/**
 * Readable RJSF validation errors (`apps/web`), shared by every
 * schema-driven form.
 *
 * @module apps/web/src/lib/readable-form-errors
 */

import type { ErrorSchema, RJSFValidationError } from '@rjsf/utils';
import {
  describeSchemaIssue,
  fieldLabel,
  formatFieldErrors,
  type FieldError,
  type SchemaIssue,
} from '@aggregator-dpg/network-config/field-errors';

/**
 * Sentences for the form standard: a missing field says it is required; a
 * wrong one says "Invalid entry" with the reason. The optional entries word
 * the reason in the user's language; without them the English text is used.
 */
export interface FieldErrorCopy {
  required: (label: string) => string;
  invalid: (message: string) => string;
  validValue?: (label: string) => string;
  minLength?: (label: string, limit: string) => string;
  maxLength?: (label: string, limit: string) => string;
}

/** True for an error that means "nothing entered" rather than "entered wrongly". */
export function isMissingError(name: string | undefined, params: unknown): boolean {
  const limit = (params as Record<string, unknown> | undefined)?.['limit'];
  return name === 'required' || (name === 'minLength' && limit === 1);
}

/** Walks `schema` along dot-path segments; numeric segments step into `items`. */
function schemaNodeAt(schema: unknown, segments: string[]): Record<string, unknown> | undefined {
  let node: unknown = schema;
  for (const seg of segments) {
    if (!node || typeof node !== 'object') return undefined;
    const n = node as Record<string, unknown>;
    const props = n['properties'] as Record<string, unknown> | undefined;
    if (/^\d+$/.test(seg) && n['items']) node = n['items'];
    else if (props && Object.hasOwn(props, seg)) node = props[seg];
    else return undefined;
  }
  return node as Record<string, unknown> | undefined;
}

function asSentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** Field-named wording for keywords whose Ajv text is developer-facing. */
function invalidMessage(
  keyword: string | undefined,
  label: string,
  limit: unknown,
  fallback: string,
  copy: FieldErrorCopy,
  authored: boolean,
): string {
  const max = typeof limit === 'number' || typeof limit === 'string' ? String(limit) : '';
  switch (keyword) {
    case 'pattern':
      // A network's own `x-error-message` wins; otherwise name the field.
      return authored ? fallback : (copy.validValue?.(label) ?? `Please enter a valid ${label}.`);
    case 'format':
    case 'type':
      return copy.validValue?.(label) ?? `Please enter a valid ${label}.`;
    case 'minLength':
      return copy.minLength?.(label, max) ?? `${label} must be at least ${max} characters.`;
    case 'maxLength':
      return copy.maxLength?.(label, max) ?? `${label} must be at most ${max} characters.`;
    default:
      return fallback;
  }
}

/**
 * Rewrites RJSF's validation errors into the wording the participant sees.
 *
 * Each message comes from the shared `field-errors` rules, so a failed URL
 * reads "Please enter a valid web address." and a failed pattern never shows
 * its regex. Without `copy`, `stack` is `Label: message`. With `copy`, the
 * message is a full sentence and `stack` equals it.
 *
 * @param errors - RJSF's errors for the current form data.
 * @param schema - The schema the form validated against (titles, examples, URL marker).
 * @param copy - Optional form-standard sentences (required / invalid).
 * @returns The same errors with readable `message` and `stack`.
 */
export function readableFormErrors(
  errors: RJSFValidationError[],
  schema: unknown,
  copy?: FieldErrorCopy,
): RJSFValidationError[] {
  return errors.map((e) => {
    const params = (e.params ?? {}) as Record<string, unknown>;
    // RJSF's `property` (".address.city") already ends with the missing key
    // for a `required` error; `describeSchemaIssue` appends it again itself.
    const segments = (e.property ?? '').split('.').filter(Boolean);
    if (e.name === 'required' && segments.at(-1) === params['missingProperty']) segments.pop();
    if (e.name === 'additionalProperties' && segments.at(-1) === params['additionalProperty']) {
      segments.pop();
    }
    const d = describeSchemaIssue(
      {
        ...(e.name !== undefined ? { keyword: e.name } : {}),
        instancePath: segments.map((seg) => `/${seg}`).join(''),
        params,
        ...(e.message !== undefined ? { message: e.message } : {}),
      },
      schema,
    );
    if (!copy) return { ...e, message: d.message, stack: formatFieldErrors([d]) };

    const node = schemaNodeAt(schema, d.field.split('.').filter(Boolean));
    const authored = typeof node?.['x-error-message'] === 'string';
    const missing = isMissingError(e.name, params) || d.message === 'is required';
    const message = missing
      ? copy.required(d.label)
      : copy.invalid(
          asSentence(invalidMessage(e.name, d.label, params['limit'], d.message, copy, authored)),
        );
    return { ...e, message, stack: message };
  });
}

/**
 * Adds `message` under `path` in an RJSF error schema. Paths come from the
 * server, so only own properties are followed and `__proto__` is refused.
 */
function addError(target: Record<string, unknown>, path: string, message: string): void {
  let node = target;
  for (const seg of path.split('.').filter(Boolean)) {
    if (seg === '__proto__') return;
    if (!Object.hasOwn(node, seg)) node[seg] = {};
    node = node[seg] as Record<string, unknown>;
  }
  if (!Object.hasOwn(node, '__errors')) node['__errors'] = [];
  const list = node['__errors'] as string[];
  if (!list.includes(message)) list.push(message);
}

/**
 * Builds an RJSF error schema from ready-worded messages keyed by dot path.
 *
 * @param messages - `{ "contact.email": "message" }`.
 * @returns The error schema, or `null` when there are no messages.
 */
export function messagesToErrorSchema(
  messages: Readonly<Record<string, string>>,
): ErrorSchema | null {
  const root: Record<string, unknown> = {};
  let any = false;
  for (const [path, message] of Object.entries(messages)) {
    if (!path || !message || path.split('.').includes('__proto__')) continue;
    addError(root, path, message);
    any = true;
  }
  return any ? (root as ErrorSchema) : null;
}

/** True for an issue whose fields have the types the mapping reads. */
function isIssue(i: unknown): i is SchemaIssue {
  if (!i || typeof i !== 'object') return false;
  const { keyword, instancePath, params, message } = i as Record<string, unknown>;
  return (
    (keyword === undefined || typeof keyword === 'string') &&
    (instancePath === undefined || typeof instancePath === 'string') &&
    (message === undefined || typeof message === 'string') &&
    (params === undefined || (typeof params === 'object' && params !== null))
  );
}

/**
 * Maps the API's `fields.issues` / `fields.field_errors` onto form fields, worded like client errors.
 *
 * @param fields - The API's `error.fields`.
 * @returns RJSF `extraErrors` plus the messages, or `null` when nothing maps to a field.
 *   `complete` is false when some message names a field the schema does not have.
 */
export function serverFieldErrors(
  fields: Record<string, unknown> | undefined,
  schema: unknown,
  copy: FieldErrorCopy,
): { errorSchema: ErrorSchema; lines: string[]; complete: boolean } | null {
  const errorSchema: Record<string, unknown> = {};
  const lines: string[] = [];
  let complete = true;
  const add = (path: string, message: string): void => {
    const segments = path.split('.').filter(Boolean);
    if (segments.length === 0 || !schemaNodeAt(schema, segments)) {
      complete = false;
      return;
    }
    addError(errorSchema, path, message);
    if (!lines.includes(message)) lines.push(message);
  };

  const issues = Array.isArray(fields?.['issues']) ? (fields['issues'] as SchemaIssue[]) : [];
  const asRjsf: RJSFValidationError[] = issues.filter(isIssue).map((i) => {
    const segs = (i.instancePath ?? '').split('/').filter(Boolean);
    const missing = i.params?.['missingProperty'];
    if (i.keyword === 'required' && typeof missing === 'string') segs.push(missing);
    return {
      ...(i.keyword !== undefined ? { name: i.keyword } : {}),
      property: segs.length ? `.${segs.join('.')}` : '',
      params: i.params ?? {},
      message: i.message ?? '',
      stack: i.message ?? '',
      schemaPath: i.schemaPath ?? '',
    };
  });
  for (const e of readableFormErrors(asRjsf, schema, copy)) add(e.property ?? '', e.message ?? '');

  const raw = fields?.['field_errors'];
  let worded: FieldError[] = [];
  if (Array.isArray(raw)) worded = raw as FieldError[];
  else if (raw && typeof raw === 'object' && lines.length === 0) {
    worded = Object.entries(raw as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .filter(([field]) => !field.split('.').includes('__proto__'))
      .map(([field, message]) => ({ field, label: fieldLabel(schema, field), message }));
  }
  for (const f of worded) {
    if (typeof f?.field !== 'string' || !f.field || typeof f.message !== 'string') continue;
    add(
      f.field,
      f.message === 'is required' ? copy.required(f.label) : copy.invalid(asSentence(f.message)),
    );
  }
  return lines.length > 0 ? { errorSchema: errorSchema as ErrorSchema, lines, complete } : null;
}
