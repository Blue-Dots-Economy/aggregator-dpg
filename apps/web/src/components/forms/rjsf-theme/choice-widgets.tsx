/**
 * Choice widgets of the RJSF theme: single select, checkbox and multi-select.
 *
 * @module apps/web/components/forms/rjsf-theme/choice-widgets
 */
import type { WidgetProps } from '@rjsf/utils';
import { enumOptionsIndexForValue, enumOptionsValueForIndex } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { MultiSelect } from '@/components/ui/MultiSelect';

/**
 * Dropdown for an enum field, with a clear button on an optional field.
 *
 * @param props - RJSF widget props.
 * @returns The select and its clear button.
 */
export function SelectWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, options, placeholder } = props;
  const t = useTranslations('form');
  const enumOptions = options.enumOptions ?? [];
  // Options are addressed by index, since Radix values are strings only. This
  // keeps boolean and numeric enum values their original type, as in Signals-DPG.
  // `''` means no selection and shows the placeholder.
  // `value` is always passed so the Select stays controlled.
  const selectedIndex = enumOptionsIndexForValue(value, enumOptions, false);
  const current = typeof selectedIndex === 'string' ? selectedIndex : '';
  // Clear button: only for an optional, unlocked field that has a value.
  const clearable = !required && current !== '' && !disabled && !readonly;
  return (
    <div className="relative">
      <Select
        value={current}
        onValueChange={(index) =>
          onChange(enumOptionsValueForIndex(index, enumOptions, options['emptyValue']))
        }
        disabled={Boolean(disabled || readonly)}
        required={Boolean(required)}
      >
        <SelectTrigger
          id={id}
          {...(required ? { 'aria-required': true } : {})}
          // Pads the value span (the only direct <span> child) to make room for
          // the overlaid clear button. The button cannot nest in the trigger,
          // which is itself a <button>. Padding the trigger would move the chevron.
          className={clearable ? '[&>span]:pr-7' : undefined}
        >
          {/* `||`, not `??`: RJSF passes `''` when no `ui:placeholder` is set. */}
          <SelectValue placeholder={placeholder || t('select_placeholder')} />
        </SelectTrigger>
        <SelectContent>
          {enumOptions.map((opt, index) => (
            <SelectItem key={`${index}-${opt.label}`} value={String(index)}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {clearable && (
        <button
          type="button"
          // Same empty value as the text widgets, so RJSF drops the key.
          onClick={() => onChange(options['emptyValue'])}
          aria-label={t('clear_selection')}
          title={t('clear_selection')}
          // `right-8` sits just left of the chevron.
          className="absolute inset-y-0 right-8 my-auto flex h-6 w-6 items-center justify-center rounded-md text-(--bd-fg-muted) transition-colors hover:bg-(--bd-border-soft) hover:text-(--bd-fg) focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--bd-primary-50)"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * Checkbox for a boolean field, with its label beside it.
 *
 * @param props - RJSF widget props.
 * @returns The labelled checkbox.
 */
export function CheckboxWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, label } = props;
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer">
      <input
        id={id}
        type="checkbox"
        className="w-[18px] h-[18px] rounded-[5px] mt-0.5 accent-(--bd-primary)"
        checked={Boolean(value)}
        required={required}
        disabled={disabled || readonly}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-[13.5px] text-ink-700 leading-relaxed">{label}</span>
    </label>
  );
}

/**
 * Multi-select dropdown for array-of-enum schemas.
 *
 * Picked values show as removable chips. Writes `string[]`, or `undefined` when empty.
 *
 * @param props - RJSF widget props.
 * @returns The multi-select.
 */
export function CheckboxesWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, options, placeholder } = props;
  const t = useTranslations('form');
  const current: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  return (
    <MultiSelect
      id={id}
      options={options.enumOptions ?? []}
      value={current}
      onChange={(next) => onChange(next.length > 0 ? next : undefined)}
      placeholder={placeholder ?? t('select_options')}
      disabled={Boolean(disabled || readonly)}
      required={Boolean(required)}
    />
  );
}
