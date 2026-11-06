'use client';

/**
 * Phone field for `@aggregator-dpg/web` forms: an editable country code that
 * starts at +91 next to the number, so the number box takes only digits and
 * stops at the length that code allows.
 *
 * @module apps/web/src/components/forms/PhoneInput
 */

import { useState, type FocusEvent, type InputHTMLAttributes } from 'react';
import { useTranslations } from 'next-intl';
import {
  DEFAULT_DIAL_CODE,
  joinPhone,
  nationalMaxLength,
  sanitizeDialCode,
  splitPhone,
  nationalFromInput,
} from '../../lib/phone';

/** Props for {@link PhoneInput}. */
export interface PhoneInputProps {
  /** Id of the number box; the code box gets `${id}-code`. */
  id: string;
  /** Stored value, `+<code><number>` (a bare 10-digit value reads as +91). */
  value: string | undefined;
  /** Called with the joined value, or `undefined` when the number is empty. */
  onChange: (value: string | undefined) => void;
  /** Called when focus leaves the number or code box. */
  onBlur?: () => void;
  onFocus?: () => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  /** Extra attributes for the number box, e.g. `aria-invalid` / `aria-describedby`. */
  inputProps?: InputHTMLAttributes<HTMLInputElement>;
  className?: string;
  'aria-label'?: string;
  /**
   * Store only the 10-digit national number, for fields whose schema pattern
   * accepts no country code; the +91 box is then shown read-only.
   */
  nationalOnly?: boolean;
}

/**
 * Country code plus number; the code defaults to India and can be typed over.
 */
export function PhoneInput({
  id,
  value,
  onChange,
  onBlur,
  onFocus,
  disabled,
  required,
  placeholder,
  inputProps,
  className,
  'aria-label': ariaLabel,
  nationalOnly = false,
}: Readonly<PhoneInputProps>) {
  const t = useTranslations('form');
  // The typed code is kept here, so it survives an empty number box and is not
  // re-guessed from the stored value while the user types.
  const [code, setCode] = useState(() => (value ? splitPhone(value).code : DEFAULT_DIAL_CODE));
  // A code box emptied to "+" keeps the number on its last full code.
  const editingCode = code.length > 1 ? code : null;
  const parts =
    !nationalOnly && editingCode && value?.startsWith(editingCode) === true
      ? { code: editingCode, national: value.slice(editingCode.length).replace(/\D/g, '') }
      : splitPhone(value);
  const savedCode = nationalOnly
    ? DEFAULT_DIAL_CODE
    : value
      ? parts.code
      : (editingCode ?? DEFAULT_DIAL_CODE);
  const shownCode = code.length > 1 || nationalOnly ? savedCode : code;
  const max = nationalMaxLength(savedCode);
  // Typed or pasted text; a pasted full number keeps its own code.
  const apply = (raw: string) => {
    const next = nationalFromInput(raw, savedCode);
    const nextCode = nationalOnly ? DEFAULT_DIAL_CODE : next.code;
    setCode(nextCode);
    onChange(nationalOnly ? next.national || undefined : joinPhone(nextCode, next.national));
  };

  const leave = (e: FocusEvent<HTMLInputElement>) => {
    const next = e.relatedTarget;
    if (next instanceof HTMLElement && (next.id === id || next.id === `${id}-code`)) return;
    onBlur?.();
  };

  return (
    <div className={`flex gap-2 ${className ?? ''}`}>
      <input
        id={`${id}-code`}
        className="bd-input w-[4.75rem] shrink-0 text-center"
        type="tel"
        inputMode="tel"
        autoComplete="tel-country-code"
        aria-label={t('phone_code_label')}
        value={shownCode}
        maxLength={4}
        disabled={disabled}
        readOnly={nationalOnly}
        onChange={(e) => {
          const nextCode = sanitizeDialCode(e.target.value);
          setCode(nextCode);
          // A bare "+" is not a code yet; keep the stored number until digits follow.
          if (nextCode.length < 2) return;
          const digits = parts.national.slice(0, nationalMaxLength(nextCode));
          if (digits) onChange(joinPhone(nextCode, digits));
        }}
        onBlur={(e) => {
          if (code.length < 2) setCode(savedCode);
          leave(e);
        }}
      />
      <input
        id={id}
        className="bd-input min-w-0 flex-1"
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        value={parts.national}
        maxLength={max}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        {...inputProps}
        onChange={(e) => apply(e.target.value)}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text');
          if (!pasted) return;
          e.preventDefault();
          apply(pasted);
        }}
        onFocus={onFocus}
        onBlur={leave}
      />
    </div>
  );
}
