'use client';

/**
 * RJSF phone widget: the deployment's country code (India by default), beside a
 * number box that takes only digits (`PhoneInput`). The form stores
 * `+<code><digits>`, or the bare number when the field's pattern accepts only that.
 */

import { useEffect } from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { PHONE_COUNTRY_CODE } from '@aggregator-dpg/shared-primitives/phone';
import { PhoneInput } from '../PhoneInput';
import { errorAria } from '../error-aria';
import { joinPhone, phoneValueMode, splitPhone, type PhoneCountries } from '@/lib/phone';
import { usePhoneCountries } from '@/lib/FormRuntimeConfigProvider';

/** India's code; network schemas write their sample placeholders with it. */
const PREFIX = `+${PHONE_COUNTRY_CODE}`;

/** Characters a phone number is written with; other text is left as typed. */
const PHONE_LAYOUT = /^[\d+\s\-().]+$/;

/** The stored value in this widget's own layout, or `undefined` when it already is. */
function tidyPhone(
  value: unknown,
  nationalOnly: boolean,
  countries: PhoneCountries,
): string | undefined {
  if (typeof value !== 'string' || !PHONE_LAYOUT.test(value)) return undefined;
  const { code, national } = splitPhone(value, countries);
  const next = nationalOnly ? national : joinPhone(code, national);
  return next && next !== value ? next : undefined;
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
  const countries = usePhoneCountries();
  const nationalOnly = phoneValueMode(schema?.pattern, countries) === 'national';
  // A value saved in another layout (`+91 98765 43210`, `919876543210`) is
  // stored in the form this widget writes, so it is checked as shown.
  const tidy = disabled || readonly ? undefined : tidyPhone(value, nationalOnly, countries);
  useEffect(() => {
    if (tidy !== undefined) onChange(tidy);
  }, [tidy, onChange]);
  // A placeholder written with the code ("+91 98765 43210") shows without it.
  const text = typeof placeholder === 'string' ? placeholder.trim() : '';
  const shown = [{ code: PREFIX }, ...countries].find((c) => text.startsWith(c.code));
  const hint = shown ? text.slice(shown.code.length).trim() : text;
  return (
    <PhoneInput
      id={id}
      nationalOnly={nationalOnly}
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
