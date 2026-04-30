'use client';

import Form from '@rjsf/core';
import type { FormProps } from '@rjsf/core';
import validatorAjv8 from '@rjsf/validator-ajv8';
import type {
  RegistryWidgetsType,
  WidgetProps,
  FieldTemplateProps,
  ObjectFieldTemplateProps,
  TitleFieldProps,
  ValidatorType,
  RJSFSchema,
  GenericObjectType,
} from '@rjsf/utils';
import type { ChangeEvent } from 'react';

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
  const { id, value, required, disabled, readonly, onChange, options } = props;
  const enumOptions =
    (options['enumOptions'] as { value: unknown; label: string }[] | undefined) ?? [];
  return (
    <select
      id={id}
      className="bd-input appearance-none pr-10"
      value={value ?? ''}
      required={required}
      disabled={disabled || readonly}
      onChange={(e) => onChange(e.target.value === '' ? options['emptyValue'] : e.target.value)}
    >
      <option value="">— select —</option>
      {enumOptions.map((opt) => (
        <option key={String(opt.value)} value={String(opt.value)}>
          {opt.label}
        </option>
      ))}
    </select>
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
  const { id, label, required, description, errors, children, displayLabel, schema } = props;
  const isCheckbox = schema.type === 'boolean';
  if (isCheckbox) {
    return (
      <div className="form-group mb-3">
        {children}
        {description}
        {errors}
      </div>
    );
  }
  return (
    <div className="form-group mb-4">
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
  return (
    <div className="space-y-4">
      {title && (
        <div>
          <h3 className="font-display font-bold text-[15px] text-ink-900">{title}</h3>
          {description && <p className="text-[12.5px] text-ink-400 mt-0.5">{description}</p>}
        </div>
      )}
      <div
        className={
          layout === 'grid'
            ? 'grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-4'
            : 'flex flex-col gap-4'
        }
      >
        {properties.map((p) => {
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

function TitleField(_props: TitleFieldProps) {
  return null;
}

// RJSF picks specialised widgets for `format: "email" | "uri" | "tel"` etc.
// The defaults render unstyled <input>s — alias them to TextWidget so the
// shared `.bd-input` styling applies everywhere.
const widgets: RegistryWidgetsType = {
  TextWidget,
  TextareaWidget,
  SelectWidget,
  DateWidget,
  CheckboxWidget,
  EmailWidget: TextWidget,
  URLWidget: TextWidget,
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
  const validator = validatorAjv8 as unknown as ValidatorType<T, RJSFSchema, GenericObjectType>;
  return (
    <div className={className}>
      <Form<T>
        showErrorList={showErrorList}
        liveValidate={liveValidate}
        noHtml5Validate={noHtml5Validate}
        {...props}
        validator={validator}
        widgets={widgets}
        templates={{ FieldTemplate, ObjectFieldTemplate, TitleFieldTemplate: TitleField }}
      />
    </div>
  );
}
