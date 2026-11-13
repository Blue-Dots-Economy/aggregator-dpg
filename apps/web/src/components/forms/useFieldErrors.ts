'use client';

/**
 * Form-standard error behaviour for RJSF forms in `@aggregator-dpg/web`:
 * format errors show when a field is left, missing-field errors after the first
 * Submit, and server field errors on their field.
 *
 * @module apps/web/src/components/forms/useFieldErrors
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { deepEquals, getByPath } from '@rjsf/utils';
import type { ErrorSchema, RJSFSchema, RJSFValidationError } from '@rjsf/utils';
import {
  isMissingError,
  readableFormErrors,
  serverFieldErrors,
  type FieldErrorCopy,
} from '@/lib/readable-form-errors';

/**
 * Builds the required / invalid sentences from the `form.error_*` messages.
 *
 * @returns Copy for {@link readableFormErrors}.
 */
export function useFieldErrorCopy(): FieldErrorCopy {
  const t = useTranslations('form');
  return useMemo(
    () => ({
      required: (label) => t('error_required', { label }),
      invalid: (message) => t('error_invalid', { message }),
      validValue: (label) => t('invalid_value', { label }),
      minLength: (label, limit) => t('too_short', { label, limit }),
      maxLength: (label, limit) => t('too_long', { label, limit }),
    }),
    [t],
  );
}

/** RJSF widget id for an error's property path (`.contact.phone` → `root_contact_phone`). */
function widgetId(property: string | undefined): string {
  return ['root', ...(property ?? '').split('.').filter(Boolean)].join('_');
}

/** Props and state {@link useFieldErrors} hands to a form. */
export interface FieldErrors {
  /** True once the user has pressed Submit. */
  attempted: boolean;
  /** Shows every error, as a submit does; the form calls it itself on any submit. */
  markAttempted: () => void;
  /**
   * Shows the API's `error.fields` on their fields, plus ready-worded `extra`
   * messages keyed by dot path, and focuses the first such field.
   */
  setServerErrors: (
    fields: Record<string, unknown> | undefined,
    extra?: Readonly<Record<string, string>>,
  ) => ServerErrorOutcome;
  /** Spread onto `<RjsfThemedForm>`. */
  formProps: {
    liveValidate: 'onBlur' | 'onChange';
    onSubmitAttempt: () => void;
    onBlur: (id: string) => void;
    transformErrors: (errors: RJSFValidationError[]) => RJSFValidationError[];
    extraErrors?: ErrorSchema;
  };
  /**
   * Call from the form's `onChange` with RJSF's field id; clears that field's
   * server error, unless `values` shows its value did not change.
   */
  onFormChange: (id?: string, values?: FormChangeValues) => void;
}

/** The form data before and after a change, for {@link FieldErrors.onFormChange}. */
export interface FormChangeValues {
  /** Form data before the change. */
  before: unknown;
  /** Form data RJSF reported. */
  after: unknown;
}

/** What {@link FieldErrors.setServerErrors} placed. */
export interface ServerErrorOutcome {
  /** True when every message found its field. */
  complete: boolean;
  /** Messages whose field is not on the form, for the caller's banner. */
  unmapped: string[];
}

/**
 * Adds ready-worded messages to the API's `field_errors`, whatever shape it sent.
 *
 * @param fields - The API's `error.fields`.
 * @param extra - Messages keyed by dot path.
 * @returns `fields` with the messages merged into `field_errors`.
 */
export function withExtraMessages(
  fields: Record<string, unknown> | undefined,
  extra: Readonly<Record<string, string>>,
): Record<string, unknown> | undefined {
  if (Object.keys(extra).length === 0) return fields;
  const current = fields?.['field_errors'];
  const fieldErrors = Array.isArray(current)
    ? [...current, ...Object.entries(extra).map(([field, message]) => ({ field, message }))]
    : { ...(isPlainObject(current) ? current : {}), ...extra };
  return { ...fields, field_errors: fieldErrors };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Dot paths of the fields an error schema marks, in order. */
function markedPaths(node: ErrorSchema, prefix: string[] = []): string[][] {
  const out: string[][] = [];
  if (Array.isArray(node.__errors) && node.__errors.length > 0) out.push(prefix);
  for (const [key, child] of Object.entries(node)) {
    if (key === '__errors' || !isPlainObject(child)) continue;
    out.push(...markedPaths(child, [...prefix, key]));
  }
  return out;
}

/** The error schema without the messages of the field whose widget id is `id`. */
function withoutField(node: ErrorSchema, id: string, prefix: string[] = []): ErrorSchema {
  const out: ErrorSchema = {};
  for (const [key, child] of Object.entries(node)) {
    if (key === '__errors') {
      if (['root', ...prefix].join('_') !== id) out.__errors = node.__errors ?? [];
      continue;
    }
    if (isPlainObject(child)) out[key] = withoutField(child, id, [...prefix, key]);
  }
  return out;
}

/** Dot path of the error-schema field whose widget id is `id`. */
function pathForId(node: ErrorSchema, id: string, prefix: string[] = []): string[] | undefined {
  if (['root', ...prefix].join('_') === id && Array.isArray(node.__errors)) return prefix;
  for (const [key, child] of Object.entries(node)) {
    if (key === '__errors' || !isPlainObject(child)) continue;
    const found = pathForId(child, id, [...prefix, key]);
    if (found) return found;
  }
  return undefined;
}

/** True when `values` shows the field at `path` kept its value (e.g. a blur). */
function unchangedAt(path: string[], values: FormChangeValues | undefined): boolean {
  if (!values) return false;
  const at = (data: unknown): unknown => (path.length === 0 ? data : getByPath(data, path));
  return deepEquals(at(values.before), at(values.after));
}

/**
 * Applies the form standard to one RJSF form.
 *
 * @param schema - The schema the form renders (labels and examples).
 * @returns Error state, Submit helpers and the props for the form.
 */
export function useFieldErrors(schema: RJSFSchema): FieldErrors {
  const copy = useFieldErrorCopy();
  const attemptedRef = useRef(false);
  const touched = useRef(new Set<string>());
  const [attempted, setAttempted] = useState(false);
  const [server, setServer] = useState<{ errorSchema: ErrorSchema } | null>(null);

  const markAttempted = useCallback(() => {
    attemptedRef.current = true;
    setAttempted(true);
  }, []);

  const transformErrors = useCallback(
    (errors: RJSFValidationError[]) =>
      readableFormErrors(
        attemptedRef.current
          ? errors
          : errors.filter(
              (e) => !isMissingError(e.name, e.params) && touched.current.has(widgetId(e.property)),
            ),
        schema,
        copy,
      ),
    [schema, copy],
  );

  const setServerErrors = useCallback(
    (fields: Record<string, unknown> | undefined, extra: Readonly<Record<string, string>> = {}) => {
      const mapped = serverFieldErrors(withExtraMessages(fields, extra), schema, copy);
      const placed = mapped && mapped.lines.length > 0 ? mapped : null;
      setServer(placed ? { errorSchema: placed.errorSchema } : null);
      const first = placed ? markedPaths(placed.errorSchema)[0] : undefined;
      if (first) {
        requestAnimationFrame(() => document.getElementById(['root', ...first].join('_'))?.focus());
      }
      return { complete: mapped?.complete === true, unmapped: mapped?.unmapped ?? [] };
    },
    [schema, copy],
  );

  return {
    attempted,
    markAttempted,
    setServerErrors,
    formProps: {
      liveValidate: attempted ? 'onChange' : 'onBlur',
      onSubmitAttempt: markAttempted,
      onBlur: (id) => touched.current.add(id),
      transformErrors,
      ...(server ? { extraErrors: server.errorSchema } : {}),
    },
    onFormChange: (id, values) => {
      if (!server || !id) return;
      const path = pathForId(server.errorSchema, id);
      if (!path || unchangedAt(path, values)) return;
      setServer({ errorSchema: withoutField(server.errorSchema, id) });
    },
  };
}
