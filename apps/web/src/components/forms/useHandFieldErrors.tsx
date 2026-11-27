'use client';

/**
 * Form-standard error behaviour for hand-built (non-RJSF) forms in
 * `@aggregator-dpg/web`: wrong values show when a field is left, missing
 * values after the first Submit, every message under its own control.
 *
 * @module apps/web/src/components/forms/useHandFieldErrors
 */

import { useCallback, useRef, useState, type JSX } from 'react';

/** One field's current problem; `required` waits for a Submit, `invalid` shows on blur. */
export interface HandFieldError {
  kind: 'required' | 'invalid';
  message: string;
}

/** Accessibility and blur wiring for one control. */
export interface HandControlProps {
  id: string;
  onBlur: () => void;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
}

/** State and helpers {@link useHandFieldErrors} hands to a form. */
export interface HandFieldErrors<K extends string> {
  /** True once the user has pressed Submit. */
  attempted: boolean;
  /** The message to show under `key` now, if any. */
  message: (key: K) => string | undefined;
  /** Spread onto the control for `key`. */
  controlProps: (key: K) => HandControlProps;
  /** Id of the message element for `key`. */
  errorId: (key: K) => string;
  /** On Submit: true when nothing blocks; otherwise shows every error and focuses the first. */
  validate: () => boolean;
  /** Shows every error without moving focus, for a Submit another form also handles. */
  markAttempted: () => void;
  /** Treats `key` as left by the user, so a wrong value shows at once. */
  touch: (key: K) => void;
  /** Shows server messages on their fields until {@link HandFieldErrors.clearServer}. */
  setServerErrors: (errors: Partial<Record<K, string>>) => void;
  /** Drops server messages (all, or one field's). */
  clearServer: (key?: K) => void;
  /** Forgets the attempt and touched fields, e.g. after a successful submit. */
  reset: () => void;
}

/**
 * Applies the form standard to a hand-built form.
 *
 * @param prefix - Id prefix for the controls (`<prefix>-<key>`).
 * @param errors - Current problems per field, in display order.
 * @returns Error state and helpers.
 */
export function useHandFieldErrors<K extends string>(
  prefix: string,
  errors: Partial<Record<K, HandFieldError | null | undefined>>,
): HandFieldErrors<K> {
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<K>>(new Set());
  const [server, setServer] = useState<Partial<Record<K, string>>>({});
  const errorsRef = useRef(errors);
  errorsRef.current = errors;

  const id = useCallback((key: K) => `${prefix}-${key}`, [prefix]);
  const errorId = useCallback((key: K) => `${prefix}-${key}__error`, [prefix]);

  const message = (key: K): string | undefined => {
    const e = errors[key];
    if (e && (attempted || (e.kind === 'invalid' && touched.has(key)))) return e.message;
    return server[key];
  };

  const touch = (key: K): void => setTouched((s) => (s.has(key) ? s : new Set(s).add(key)));

  const validate = (): boolean => {
    setAttempted(true);
    const first = Object.entries(errorsRef.current).find(([, e]) => e)?.[0];
    if (first === undefined) return true;
    requestAnimationFrame(() => document.getElementById(`${prefix}-${first}`)?.focus());
    return false;
  };

  return {
    attempted,
    message,
    errorId,
    controlProps: (key) => ({
      id: id(key),
      onBlur: () => touch(key),
      ...(message(key) ? { 'aria-invalid': true as const, 'aria-describedby': errorId(key) } : {}),
    }),
    validate,
    markAttempted: () => setAttempted(true),
    touch,
    setServerErrors: (errors) => {
      setServer(errors);
      // Move to the first field the server named, as a Submit does for the form's own checks.
      const first = Object.entries(errors).find(([, message]) => message)?.[0];
      if (first !== undefined) {
        requestAnimationFrame(() => document.getElementById(`${prefix}-${first}`)?.focus());
      }
    },
    clearServer: (key) =>
      setServer((s) => {
        if (key === undefined) return {};
        if (!(key in s)) return s;
        const next = { ...s };
        delete next[key];
        return next;
      }),
    reset: () => {
      setAttempted(false);
      setTouched(new Set());
      setServer({});
    },
  };
}

/**
 * `message` when `show` is true, else `null`; for a control's message that
 * appears only after Submit.
 *
 * @param show - Whether the message applies now.
 * @param message - The message text.
 */
export function messageWhen(show: boolean, message: string): string | null {
  return show ? message : null;
}

/**
 * `aria-invalid` + `aria-describedby` for a control whose message is `message`.
 *
 * @param errorId - Id of the element that shows the message.
 * @param message - The current message, if any.
 * @returns The two attributes, or nothing when there is no message.
 */
export function errorAriaProps(
  errorId: string,
  message: string | null | undefined,
): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
  return message ? { 'aria-invalid': true, 'aria-describedby': errorId } : {};
}

/**
 * Red message under a control; renders nothing without a message.
 *
 * @param props - The message element id and text.
 * @returns The message, or `null`.
 */
export function FieldMessage({
  id,
  message,
}: Readonly<{
  id: string;
  message: string | undefined | null;
}>): JSX.Element | null {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-[11.5px] text-red-500">
      {message}
    </p>
  );
}
