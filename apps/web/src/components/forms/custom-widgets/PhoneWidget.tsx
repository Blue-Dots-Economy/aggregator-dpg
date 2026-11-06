'use client';

/**
 * RJSF phone widget: an editable country code that starts at +91, beside a
 * number box that takes only digits (`PhoneInput`). The form stores
 * `+<code><digits>`, or the bare number when the field's pattern accepts only that.
 */

import type { WidgetProps } from '@rjsf/utils';
import { PHONE_COUNTRY_CODE, PHONE_LOCAL_DIGITS } from '@aggregator-dpg/shared-primitives/phone';
import { PhoneInput } from '../PhoneInput';
import { errorAria } from '../error-aria';
import { phoneValueMode } from '../../../lib/phone';

const PREFIX = `+${PHONE_COUNTRY_CODE}`;

/** The local digits of a stored value (`+91…`, `91…` with all digits, or bare digits). */
export function localDigits(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const rest = text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text;
  let digits = rest.replace(/\D/g, '');
  if (
    !text.startsWith('+') &&
    digits.length > PHONE_LOCAL_DIGITS &&
    digits.startsWith(PHONE_COUNTRY_CODE)
  ) {
    digits = digits.slice(PHONE_COUNTRY_CODE.length);
  }
  return digits.slice(0, PHONE_LOCAL_DIGITS);
}

/**
 * RJSF widget for a phone field.
 *
 * @param props - The RJSF widget props.
 */
export function PhoneWidget(props: Readonly<WidgetProps>) {
  const {
    id,
    value,
    onChange,
    onBlur,
    onFocus,
    disabled,
    readonly,
    placeholder,
    required,
    rawErrors,
    schema,
    options,
  } = props;
  // A placeholder written with the code ("+91 98765 43210") shows without it.
  const hint = typeof placeholder === 'string' ? placeholder.replace(PREFIX, '').trim() : '';
  return (
    <PhoneInput
      id={id}
      nationalOnly={phoneValueMode(schema?.pattern) === 'national'}
      value={typeof value === 'string' ? value : undefined}
      required={Boolean(required)}
      disabled={Boolean(disabled || readonly)}
      {...(hint ? { placeholder: hint } : {})}
      inputProps={errorAria(id, rawErrors)}
      onChange={(next) => onChange(next ?? options?.['emptyValue'])}
      onBlur={() => onBlur(id, value)}
      onFocus={() => onFocus(id, value)}
    />
  );
}
