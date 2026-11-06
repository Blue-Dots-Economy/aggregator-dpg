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
import type { ErrorSchema, RJSFSchema, RJSFValidationError } from '@rjsf/utils';
import {
  isMissingError,
  messagesToErrorSchema,
  readableFormErrors,
  serverFieldErrors,
  type FieldErrorCopy,
} from '../../lib/readable-form-errors';

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
  /** Call before RJSF validates a submit (Submit click or Enter). */
  markAttempted: () => void;
  /** Shows the API's `error.fields` on their fields; false unless every message found its field. */
  setServerErrors: (fields: Record<string, unknown> | undefined) => boolean;
  /** Shows ready-worded messages (keyed by dot path) on their fields. */
  setServerMessages: (messages: Readonly<Record<string, string>>) => boolean;
  /** Spread onto `<RjsfThemedForm>`. */
  formProps: {
    liveValidate: 'onBlur' | 'onChange';
    onBlur: (id: string) => void;
    transformErrors: (errors: RJSFValidationError[]) => RJSFValidationError[];
    extraErrors?: ErrorSchema;
  };
  /** Call from the form's `onChange`; clears server errors once the user edits. */
  onFormChange: () => void;
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
    (fields: Record<string, unknown> | undefined) => {
      const mapped = serverFieldErrors(fields, schema, copy);
      setServer(mapped);
      return mapped?.complete === true;
    },
    [schema, copy],
  );

  const setServerMessages = useCallback((messages: Readonly<Record<string, string>>) => {
    const errorSchema = messagesToErrorSchema(messages);
    setServer(errorSchema ? { errorSchema } : null);
    return errorSchema !== null;
  }, []);

  return {
    attempted,
    markAttempted,
    setServerErrors,
    setServerMessages,
    formProps: {
      liveValidate: attempted ? 'onChange' : 'onBlur',
      onBlur: (id) => touched.current.add(id),
      transformErrors,
      ...(server ? { extraErrors: server.errorSchema } : {}),
    },
    onFormChange: () => {
      if (server) setServer(null);
    },
  };
}
