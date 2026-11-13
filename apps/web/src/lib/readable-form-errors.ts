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

/** True for a plain object, so its keys can be read without a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for an error that means "nothing entered" rather than "entered wrongly". */
export function isMissingError(name: string | undefined, params: unknown): boolean {
  const limit = isRecord(params) ? params['limit'] : undefined;
  return name === 'required' || ((name === 'minLength' || name === 'minItems') && limit === 1);
}

/** Walks `schema` along dot-path segments; numeric segments step into `items`. */
function schemaNodeAt(schema: unknown, segments: string[]): Record<string, unknown> | undefined {
  let node: unknown = schema;
  for (const seg of segments) {
    if (!isRecord(node)) return undefined;
    const props = node['properties'];
    if (/^\d+$/.test(seg) && node['items']) node = node['items'];
    else if (isRecord(props) && Object.hasOwn(props, seg)) node = props[seg];
    else return undefined;
  }
  return isRecord(node) ? node : undefined;
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
    const params: Record<string, unknown> = isRecord(e.params) ? e.params : {};
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
function addError(target: ErrorSchema, path: string, message: string): void {
  let node: ErrorSchema = target;
  for (const seg of path.split('.').filter(Boolean)) {
    if (seg === '__proto__') return;
    const next: ErrorSchema = Object.hasOwn(node, seg) ? (node[seg] ?? {}) : {};
    node[seg] = next;
    node = next;
  }
  const list = node.__errors ?? [];
  if (!list.includes(message)) list.push(message);
  node.__errors = list;
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
  const root: ErrorSchema = {};
  let any = false;
  for (const [path, message] of Object.entries(messages)) {
    if (!path || !message || path.split('.').includes('__proto__')) continue;
    addError(root, path, message);
    any = true;
  }
  return any ? root : null;
}

/** True for an issue whose fields have the types the mapping reads. */
function isIssue(i: unknown): i is SchemaIssue {
  if (!isRecord(i)) return false;
  const { keyword, instancePath, params, message } = i;
  return (
    (keyword === undefined || typeof keyword === 'string') &&
    (instancePath === undefined || typeof instancePath === 'string') &&
    (message === undefined || typeof message === 'string') &&
    (params === undefined || (typeof params === 'object' && params !== null))
  );
}

/** Keys of an error's `fields` that carry detail about the request, not a form field. */
const NOT_FIELD_KEYS: ReadonlySet<string> = new Set([
  'issues',
  'field_errors',
  'missing',
  'code',
  'sub_operation',
  'rolled_back',
  'retry_after',
  'requestId',
]);

/** Server errors placed on form fields, plus the messages no field owns. */
export interface ServerFieldErrors {
  errorSchema: ErrorSchema;
  /** Messages shown on fields. */
  lines: string[];
  /** Messages whose field is not on this form. */
  unmapped: string[];
  /** True when every message found its field. */
  complete: boolean;
}

/** A worded server error, with the schema's label when the server sent none. */
function toFieldError(f: unknown, schema: unknown): FieldError | null {
  if (!isRecord(f) || typeof f['field'] !== 'string' || typeof f['message'] !== 'string') {
    return null;
  }
  const label = typeof f['label'] === 'string' ? f['label'] : fieldLabel(schema, f['field']);
  return { field: f['field'], label, message: f['message'] };
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
): ServerFieldErrors | null {
  const errorSchema: ErrorSchema = {};
  const lines: string[] = [];
  const unmapped: string[] = [];
  const mapped = new Set<string>();
  const onForm = (path: string): boolean => {
    const segments = path.split('.').filter(Boolean);
    return segments.length > 0 && schemaNodeAt(schema, segments) !== undefined;
  };
  const add = (path: string, message: string): void => {
    if (!onForm(path)) {
      if (!unmapped.includes(message)) unmapped.push(message);
      return;
    }
    mapped.add(path.split('.').filter(Boolean).join('.'));
    addError(errorSchema, path, message);
    if (!lines.includes(message)) lines.push(message);
  };

  const rawIssues: unknown = fields?.['issues'];
  const issues: SchemaIssue[] = Array.isArray(rawIssues) ? rawIssues.filter(isIssue) : [];
  const asRjsf: RJSFValidationError[] = issues.map((i) => {
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
  if (Array.isArray(raw)) {
    worded = raw.flatMap((f: unknown) => {
      const e = toFieldError(f, schema);
      return e ? [e] : [];
    });
  } else if (isRecord(raw)) {
    worded = Object.entries(raw)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .filter(([field]) => !field.split('.').includes('__proto__'))
      .map(([field, message]) => ({ field, label: fieldLabel(schema, field), message }));
  }
  for (const f of worded) {
    // A field `issues` already worded keeps that message.
    if (!f.field || mapped.has(f.field)) continue;
    add(
      f.field,
      f.message === 'is required' ? copy.required(f.label) : copy.invalid(asSentence(f.message)),
    );
  }
  // A flat `{ field: value }` marks a field without wording it; the value may be
  // the rejected input, so it is never shown.
  for (const key of Object.keys(fields ?? {})) {
    if (NOT_FIELD_KEYS.has(key) || mapped.has(key) || key.split('.').includes('__proto__'))
      continue;
    if (!onForm(key)) continue;
    const label = fieldLabel(schema, key);
    add(key, copy.invalid(asSentence(copy.validValue?.(label) ?? `Please enter a valid ${label}`)));
  }
  if (lines.length === 0 && unmapped.length === 0) return null;
  return { errorSchema, lines, unmapped, complete: unmapped.length === 0 && lines.length > 0 };
}
