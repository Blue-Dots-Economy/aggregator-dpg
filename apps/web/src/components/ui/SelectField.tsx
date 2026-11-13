'use client';

/**
 * Single-choice dropdown built on the shared `Select`, in `apps/web`.
 *
 * Takes a plain option list so a screen does not repeat the trigger, content
 * and item markup. It looks like the language switcher and the other styled
 * dropdowns, unlike a browser-native `<select>`.
 */

import type { JSX, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './Select';

/** One choice in a {@link SelectField}. */
export interface SelectFieldOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectFieldProps {
  /** The selected value; `''` shows the placeholder, or selects an option whose value is `''`. */
  value: string;
  /** Called with the chosen value. */
  onChange: (value: string) => void;
  options: readonly SelectFieldOption[];
  /** Text shown while nothing is selected. */
  placeholder?: string;
  id?: string;
  /** Form field name, for a form that is read through `FormData`. */
  name?: string;
  required?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-required'?: boolean;
  /** Marks the field as wrong: red border, announced by screen readers. */
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  onBlur?: () => void;
  /** Shown before the selected value, as the language switcher shows its icon. */
  icon?: ReactNode;
  /** Extra classes for the trigger, such as a compact size. */
  className?: string;
  /** Which edge of the trigger the open list lines up with. */
  align?: 'start' | 'end';
}

/** Stands in for an option whose value is `''`, which `Select` does not allow. */
const EMPTY = '__empty__';

/**
 * Renders a styled dropdown for a plain list of choices.
 *
 * @returns The dropdown.
 */
export function SelectField({
  value,
  onChange,
  options,
  placeholder,
  id,
  name,
  required,
  disabled,
  icon,
  className,
  align = 'start',
  onBlur,
  ...aria
}: Readonly<SelectFieldProps>): JSX.Element {
  const hasEmptyOption = options.some((o) => o.value === '');
  const toItem = (v: string) => (v === '' ? EMPTY : v);
  const rootValue = value === '' && !hasEmptyOption ? '' : toItem(value);
  return (
    <Select
      value={rootValue}
      onValueChange={(v) => onChange(v === EMPTY ? '' : v)}
      {...(name === undefined ? {} : { name })}
      {...(required === undefined ? {} : { required })}
      {...(disabled === undefined ? {} : { disabled })}
    >
      <SelectTrigger
        id={id}
        className={cn(icon ? 'gap-1.5' : '', aria['aria-invalid'] && 'border-rose-400', className)}
        onBlur={onBlur}
        {...aria}
      >
        {icon}
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent align={align}>
        {options.map((o) => (
          <SelectItem key={o.value} value={toItem(o.value)} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
