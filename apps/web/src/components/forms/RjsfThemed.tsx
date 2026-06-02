'use client';

import Form from '@rjsf/core';
import type { FormProps } from '@rjsf/core';
import { customizeValidator } from '@rjsf/validator-ajv8';
import Ajv2020 from 'ajv/dist/2020';
import type {
  RegistryWidgetsType,
  WidgetProps,
  FieldTemplateProps,
  ObjectFieldTemplateProps,
  ArrayFieldTemplateProps,
  TitleFieldProps,
  ValidatorType,
  RJSFSchema,
  GenericObjectType,
} from '@rjsf/utils';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { MultiSelect } from '../ui/MultiSelect';

function TextWidget(props: WidgetProps) {
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
  const inputType = (options['inputType'] as string | undefined) ?? type ?? 'text';
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

function TextareaWidget(props: WidgetProps) {
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

function SelectWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, options, placeholder } = props;
  const t = useTranslations('form');
  const enumOptions =
    (options['enumOptions'] as { value: unknown; label: string }[] | undefined) ?? [];
  // shadcn Select disallows the empty-string sentinel as a value; map
  // empty selection to a controlled `undefined` instead and surface the
  // placeholder via SelectValue.
  const current = value !== undefined && value !== null && value !== '' ? String(value) : undefined;
  return (
    <Select
      {...(current !== undefined ? { value: current } : {})}
      onValueChange={(v) => onChange(v === '' ? options['emptyValue'] : v)}
      disabled={Boolean(disabled || readonly)}
      required={Boolean(required)}
    >
      <SelectTrigger id={id} {...(required ? { 'aria-required': true } : {})}>
        <SelectValue placeholder={placeholder ?? t('select_placeholder')} />
      </SelectTrigger>
      <SelectContent>
        {enumOptions.map((opt) => (
          <SelectItem key={String(opt.value)} value={String(opt.value)}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DateWidget(props: WidgetProps) {
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
 * Tag-style widget for an `array<string>` schema. Maintains a local string
 * mirror of the input so commas and partial tokens survive editing. The
 * earlier implementation reflowed the array → display on every keystroke
 * which stripped the trailing comma the moment the user typed it, making
 * a multi-tag entry impossible.
 *
 * Parent state syncs on each keystroke (empties dropped); blur canonicalises
 * the display back to `tag1, tag2, …`.
 */
function CommaSeparatedArrayWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, placeholder } = props;
  const t = useTranslations('form');
  const arrayValue = Array.isArray(value) ? (value as unknown[]).filter(Boolean) : [];
  const [text, setText] = useState<string>(arrayValue.join(', '));
  const lastSyncedRef = useRef<string>(arrayValue.join('|'));

  // Re-sync local text if the array prop changes from somewhere else
  // (e.g. RJSF reset). Sentinel prevents clobbering in-flight typing.
  useEffect(() => {
    const next = arrayValue.join('|');
    if (next !== lastSyncedRef.current) {
      setText(arrayValue.join(', '));
      lastSyncedRef.current = next;
    }
  }, [arrayValue]);

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
        lastSyncedRef.current = arr.join('|');
        onChange(arr.length > 0 ? arr : undefined);
      }}
      onBlur={(e) => {
        const arr = e.target.value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const canonical = arr.join(', ');
        setText(canonical);
        lastSyncedRef.current = arr.join('|');
        onChange(arr.length > 0 ? arr : undefined);
      }}
    />
  );
}

function CheckboxWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, label } = props;
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer">
      <input
        id={id}
        type="checkbox"
        className="w-[18px] h-[18px] rounded-[5px] mt-0.5 accent-[var(--bd-primary)]"
        checked={Boolean(value)}
        required={required}
        disabled={disabled || readonly}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-[13.5px] text-ink-700 leading-relaxed">{label}</span>
    </label>
  );
}

function FieldTemplate(props: FieldTemplateProps) {
  const {
    id,
    label,
    required,
    description,
    errors,
    rawErrors,
    children,
    displayLabel,
    schema,
    uiSchema,
  } = props;
  if (uiSchema?.['ui:widget'] === 'hidden') {
    return null;
  }
  const isCheckbox = schema.type === 'boolean';
  // Array fields with a custom scalar `ui:widget` (e.g. our comma-separated
  // tag input) render a leaf input, not a row-builder. Treat them as leaves
  // so the label + required marker show up normally.
  const customWidget = uiSchema?.['ui:widget'];
  const arrayAsLeaf =
    schema.type === 'array' && typeof customWidget === 'string' && customWidget !== 'hidden';
  const isContainer = (schema.type === 'object' || schema.type === 'array') && !arrayAsLeaf;
  const hasError = Array.isArray(rawErrors) && rawErrors.length > 0;
  // Red-border styling for invalid leaf inputs. Tailwind arbitrary selectors
  // descend into the widget regardless of whether it renders an <input> or a
  // <select> as long as it carries the .bd-input class.
  const errorWrap = hasError ? '[&_.bd-input]:border-rose-400 [&_.bd-input]:ring-rose-100' : '';
  if (isCheckbox) {
    return (
      <div className={`form-group ${errorWrap}`}>
        {children}
        {errors}
      </div>
    );
  }
  if (isContainer) {
    return (
      <div className="form-group">
        {children}
        {errors}
      </div>
    );
  }
  return (
    <div className={`form-group ${errorWrap}`}>
      {displayLabel && label && (
        <label className="bd-label" htmlFor={id}>
          {label}
          {required && <span className="text-rose-500"> *</span>}
        </label>
      )}
      {children}
      {description}
      {errors}
    </div>
  );
}

function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const { properties, title, description, uiSchema } = props;
  const layout = (uiSchema?.['ui:layout'] as 'grid' | 'stack' | undefined) ?? 'grid';
  // Skip the header when ui:title is explicitly empty / false — used to hide
  // auto-derived property-name headings (e.g. lowercase "address" on a
  // nested object that has no schema-level title).
  const explicitTitle = uiSchema?.['ui:title'] as string | false | undefined;
  const showTitle = explicitTitle !== '' && explicitTitle !== false && Boolean(title);
  // Drop child slots whose inner widget is `hidden` — otherwise an empty
  // wrapper div lands in the grid/stack and inflates the section height.
  const visibleProperties = properties.filter((p) => {
    const childUi = p.content.props.uiSchema as Record<string, unknown> | undefined;
    return childUi?.['ui:widget'] !== 'hidden';
  });
  return (
    <div className="space-y-3">
      {showTitle && (
        <div>
          <h3 className="font-display font-bold text-[15px] text-ink-900">{title}</h3>
          {description && <p className="text-[12.5px] text-ink-400 mt-0.5">{description}</p>}
        </div>
      )}
      <div
        className={
          layout === 'grid'
            ? 'grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-3'
            : 'flex flex-col gap-3'
        }
      >
        {visibleProperties.map((p) => {
          const span = (p.content.props.uiSchema?.['ui:colSpan'] as 1 | 2 | undefined) ?? 1;
          return (
            <div key={p.name} className={span === 2 ? 'md:col-span-2' : ''}>
              {p.content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ArrayFieldTemplate(props: ArrayFieldTemplateProps) {
  const { title, items, canAdd, onAddClick, uiSchema, formContext } = props;
  void formContext;
  const itemLabel = (uiSchema?.['ui:options']?.['itemLabel'] as string | undefined) ?? 'entry';
  const multiple = items.length > 1;
  return (
    <div className="space-y-3">
      {title && <h3 className="font-display font-bold text-[15px] text-ink-900">{title}</h3>}
      {items.map((item) => (
        <div key={item.key} className="space-y-2">
          {multiple && (
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] font-semibold text-ink-500">
                {capitalise(itemLabel)} {item.index + 1}
              </span>
              {item.hasRemove && (
                <button
                  type="button"
                  onClick={item.onDropIndexClick(item.index)}
                  className="text-[12.5px] text-rose-500 hover:text-rose-600"
                >
                  Remove
                </button>
              )}
            </div>
          )}
          {item.children}
        </div>
      ))}
      {canAdd && (
        <button
          type="button"
          onClick={onAddClick}
          className="inline-flex items-center gap-1.5 text-[13px] text-primary-600 hover:text-primary-700 font-semibold"
        >
          + Add another {itemLabel.toLowerCase()}
        </button>
      )}
    </div>
  );
}

function capitalise(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function TitleField(_props: TitleFieldProps) {
  return null;
}

// RJSF picks specialised widgets for `format: "email" | "uri" | "tel"` etc.
/**
 * Multi-select dropdown for array-of-enum schemas. Visually mirrors the
 * single-select SelectWidget (same `bd-input` chrome) so users get the
 * familiar Qualification-style dropdown; picked values surface as
 * removable chips above the dropdown. Writes the field as `string[]`
 * (or `undefined` when empty) so RJSF + Ajv see the schema's expected
 * array shape.
 */
function CheckboxesWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, options, placeholder } = props;
  const t = useTranslations('form');
  const enumOptions =
    (options['enumOptions'] as Array<{ value: string; label: string }> | undefined) ?? [];
  const current: string[] = Array.isArray(value)
    ? (value as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  return (
    <MultiSelect
      id={id}
      options={enumOptions}
      value={current}
      onChange={(next) => onChange(next.length > 0 ? next : undefined)}
      placeholder={placeholder ?? t('select_options')}
      disabled={Boolean(disabled || readonly)}
      required={Boolean(required)}
    />
  );
}

// The defaults render unstyled <input>s — alias them to TextWidget so the
// shared `.bd-input` styling applies everywhere.
const widgets: RegistryWidgetsType = {
  TextWidget,
  TextareaWidget,
  SelectWidget,
  DateWidget,
  CheckboxWidget,
  CheckboxesWidget,
  CommaSeparatedArrayWidget,
  // Email + URL fields render TextWidget but pin the native HTML
  // `type` so mobile keyboards default to the email / URL layout and
  // the browser surfaces native autofill hints.
  EmailWidget: (props: WidgetProps) => <TextWidget {...props} type="email" />,
  URLWidget: (props: WidgetProps) => <TextWidget {...props} type="url" />,
  UpDownWidget: TextWidget,
  RangeWidget: TextWidget,
  PasswordWidget: TextWidget,
  ColorWidget: TextWidget,
};

export interface RjsfThemedFormProps<T extends GenericObjectType = GenericObjectType> extends Omit<
  FormProps<T>,
  'validator' | 'widgets' | 'templates'
> {
  className?: string;
}

export function RjsfThemedForm<T extends GenericObjectType = GenericObjectType>({
  className,
  showErrorList = false,
  liveValidate = false,
  noHtml5Validate = true,
  ...props
}: RjsfThemedFormProps<T>) {
  // Customised validator with Ajv's 2020 build. The default RJSF validator
  // ships draft-07/2019-09; our schemas declare
  // `$schema: ".../draft/2020-12/schema"` and Ajv rejects the meta-ref
  // unless we hand it an Ajv class that already knows draft 2020-12.
  const validator = customizeValidator({
    AjvClass: Ajv2020 as unknown as Parameters<typeof customizeValidator>[0] extends {
      AjvClass?: infer C;
    }
      ? C
      : never,
  }) as unknown as ValidatorType<T, RJSFSchema, GenericObjectType>;
  return (
    <div className={className}>
      <Form<T>
        showErrorList={showErrorList}
        liveValidate={liveValidate}
        noHtml5Validate={noHtml5Validate}
        {...props}
        validator={validator}
        widgets={widgets}
        templates={{
          FieldTemplate,
          ObjectFieldTemplate,
          ArrayFieldTemplate,
          TitleFieldTemplate: TitleField,
        }}
      />
    </div>
  );
}
