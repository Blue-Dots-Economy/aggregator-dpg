/**
 * Free-text widgets of the RJSF theme: text, textarea, date and a
 * comma-separated list.
 *
 * Each renders a `.bd-input` so the form matches the rest of the portal.
 *
 * @module apps/web/components/forms/rjsf-theme/text-widgets
 */
import { useState, type ChangeEvent } from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { useTranslations } from 'next-intl';

/**
 * Single-line text input. `ui:options.inputType` sets the native input type.
 *
 * @param props - RJSF widget props.
 * @returns The text input.
 */
export function TextWidget(props: WidgetProps) {
  const {
    id,
    value,
    required,
    disabled,
    readonly,
    onBlur,
    onFocus,
    onChange,
    options,
    placeholder,
    type,
  } = props;
  const inputType = typeof options.inputType === 'string' ? options.inputType : (type ?? 'text');
  return (
    <input
      id={id}
      className="bd-input"
      type={inputType}
      value={value ?? ''}
      required={required}
      disabled={disabled || readonly}
      placeholder={placeholder}
      onChange={(e: ChangeEvent<HTMLInputElement>) =>
        onChange(e.target.value === '' ? options['emptyValue'] : e.target.value)
      }
      onBlur={(e) => onBlur(id, e.target.value)}
      onFocus={(e) => onFocus(id, e.target.value)}
    />
  );
}

/**
 * Multi-line text input.
 *
 * @param props - RJSF widget props.
 * @returns The textarea.
 */
export function TextareaWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, placeholder, options } = props;
  return (
    <textarea
      id={id}
      className="bd-input min-h-[80px] resize-y"
      value={value ?? ''}
      required={required}
      disabled={disabled || readonly}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? options['emptyValue'] : e.target.value)}
    />
  );
}

/**
 * Native date input.
 *
 * @param props - RJSF widget props.
 * @returns The date input.
 */
export function DateWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange } = props;
  return (
    <input
      id={id}
      className="bd-input"
      type="date"
      value={value ?? ''}
      required={required}
      disabled={disabled || readonly}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Comma-separated text input for an `array<string>` schema.
 *
 * Keeps the raw text locally so commas and partial tokens survive editing.
 * Updates the array on each keystroke and normalises the text on blur.
 *
 * @param props - RJSF widget props.
 * @returns The text input.
 */
export function CommaSeparatedArrayWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, placeholder } = props;
  const t = useTranslations('form');
  const arrayValue: unknown[] = Array.isArray(value) ? value.filter(Boolean) : [];
  const valueKey = arrayValue.join('|');
  const [text, setText] = useState<string>(arrayValue.join(', '));
  // The list the text last matched. Typing updates it, so only a list set from
  // outside (e.g. a reset) replaces the text, during render.
  const [syncedKey, setSyncedKey] = useState(valueKey);
  if (valueKey !== syncedKey) {
    setSyncedKey(valueKey);
    setText(arrayValue.join(', '));
  }

  return (
    <input
      id={id}
      className="bd-input"
      type="text"
      value={text}
      required={required}
      disabled={disabled || readonly}
      placeholder={placeholder ?? t('comma_separated')}
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        setText(e.target.value);
        const arr = e.target.value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        setSyncedKey(arr.join('|'));
        onChange(arr.length > 0 ? arr : undefined);
      }}
      onBlur={(e) => {
        const arr = e.target.value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const canonical = arr.join(', ');
        setText(canonical);
        setSyncedKey(arr.join('|'));
        onChange(arr.length > 0 ? arr : undefined);
      }}
    />
  );
}
