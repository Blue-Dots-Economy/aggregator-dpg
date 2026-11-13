'use client';

/**
 * Phone field for `@aggregator-dpg/web` forms: the country code, fixed to the
 * deployment's `PHONE_COUNTRIES` (a list only when it has more than one), next to a
 * number box that takes only digits and stops at that country's length.
 *
 * @module apps/web/src/components/forms/PhoneInput
 */

import { useState, type CSSProperties, type FocusEvent, type InputHTMLAttributes } from 'react';
import { useTranslations } from 'next-intl';
import {
  joinPhone,
  nationalMaxLength,
  phoneCountry,
  splitPhone,
  nationalFromInput,
} from '@/lib/phone';
import { usePhoneCountries } from '@/lib/FormRuntimeConfigProvider';

/** Fixed width for the code; inline because `.bd-input` sets `width: 100%`, which outranks utility classes. */
const CODE_BOX_STYLE: CSSProperties = { width: '6rem', flexShrink: 0 };

/** Props for {@link PhoneInput}. */
export interface PhoneInputProps {
  /** Id of the number box; the country list gets `${id}-code`. */
  id: string;
  /** Stored value, `+<code><number>` (a bare 10-digit value reads as +91). */
  value: string | undefined;
  /** Called with the joined value, or `undefined` when the number is empty. */
  onChange: (value: string | undefined) => void;
  /** Called when focus leaves the field. */
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
   * Store only the national number, for fields whose schema pattern
   * accepts no country code; the code then stays at the default.
   */
  nationalOnly?: boolean;
}

/**
 * Country code plus number. The code cannot be typed; with one listed country it is fixed.
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
  const countries = usePhoneCountries();
  const defaultCode = countries[0].code;
  // The picked country, kept while the number box is empty.
  const [picked, setPicked] = useState(() =>
    value ? splitPhone(value, countries).code : defaultCode,
  );
  const parts = splitPhone(value, countries);
  const typedCode = value ? parts.code : picked;
  const code = nationalOnly ? defaultCode : typedCode;
  const country = phoneCountry(code, countries);
  const maxLength = nationalMaxLength(code, countries);
  const apply = (raw: string) => {
    const next = nationalFromInput(raw, code, countries);
    const nextCode = nationalOnly ? defaultCode : next.code;
    setPicked(nextCode);
    onChange(nationalOnly ? next.national || undefined : joinPhone(nextCode, next.national));
  };

  const leave = (e: FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget;
    if (next instanceof HTMLElement && (next.id === id || next.id === `${id}-code`)) return;
    onBlur?.();
  };

  return (
    <div className={`flex gap-2 ${className ?? ''}`}>
      {countries.length > 1 && !nationalOnly ? (
        <select
          id={`${id}-code`}
          className="bd-input"
          style={CODE_BOX_STYLE}
          aria-label={t('phone_code_label')}
          value={code}
          disabled={disabled}
          onChange={(e) => {
            const nextCode = e.target.value;
            setPicked(nextCode);
            const digits = parts.national.slice(0, nationalMaxLength(nextCode, countries));
            if (digits) onChange(joinPhone(nextCode, digits));
          }}
          onBlur={leave}
        >
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {`${c.flag} ${c.code}`}
            </option>
          ))}
        </select>
      ) : (
        <span
          className="bd-input flex items-center justify-center gap-1 text-ink-500 select-none"
          style={CODE_BOX_STYLE}
          aria-label={t('phone_code_label')}
        >
          {country ? <span aria-hidden="true">{country.flag}</span> : null}
          {code}
        </span>
      )}
      <input
        id={id}
        className="bd-input min-w-0 flex-1"
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        value={parts.national}
        maxLength={maxLength}
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
