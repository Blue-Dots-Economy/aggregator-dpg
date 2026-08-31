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
  ArrayFieldItemTemplateProps,
  TitleFieldProps,
  UiSchema,
  ValidatorType,
  RJSFSchema,
  GenericObjectType,
} from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { MultiSelect } from '../ui/MultiSelect';
import { resolveVisibleSchema, stripShowIf } from '../../lib/show-if';
import { ConsentCheckboxWidget } from './ConsentCheckboxWidget';

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
  // shadcn Select disallows the empty-string sentinel as an *item* value, but
  // Radix's Root treats `value=""` as "no selection" and renders the
  // placeholder (`shouldShowPlaceholder`), so `''` is exactly the right reset.
  //
  // Always passing `value` — rather than the previous conditional spread that
  // omitted the prop when empty — keeps the Select controlled for its whole
  // life. Dropping the prop mid-life handed control back to Radix's internal
  // state, which still held the old selection: the field then showed neither
  // the cleared placeholder nor, reliably, the old label. That went unnoticed
  // while nothing could clear a value; the button below is what reaches it.
  const current = value !== undefined && value !== null && value !== '' ? String(value) : '';
  // Once a value was picked there was no way back to empty: every dropdown
  // entry sets a value, and re-picking the current one just re-sets it. That
  // left an optional field permanently answered on the strength of one
  // mis-click. Only shown where clearing is actually allowed and possible —
  // an optional field that currently holds something and isn't locked.
  const clearable = !required && current !== '' && !disabled && !readonly;
  return (
    <div className="relative">
      <Select
        value={current}
        onValueChange={(v) => onChange(v === '' ? options['emptyValue'] : v)}
        disabled={Boolean(disabled || readonly)}
        required={Boolean(required)}
      >
        <SelectTrigger
          id={id}
          {...(required ? { 'aria-required': true } : {})}
          // Room for the clear button, which is overlaid rather than nested:
          // the trigger is itself a <button>, and a button inside a button is
          // invalid HTML that browsers resolve by dropping the inner one.
          //
          // The padding goes on the VALUE span, not on the trigger. Padding
          // the trigger moves the chevron inward too (it is the flex row's
          // last child), which put the clear button *outside* the chevron at
          // the very edge of the field. The value span is the flex-1 child, so
          // padding it reserves the button's space between a long label and a
          // chevron that hasn't moved.
          className={clearable ? '[&>span]:pr-7' : undefined}
        >
          {/* `||`, not `??`: RJSF passes `placeholder: ''` (not undefined) when
              a field declares no `ui:placeholder`, so the nullish fallback
              never fired and every empty select rendered a blank box with no
              "Select…" hint at all. Radix already knew the field was empty
              (`data-placeholder` was set); it was handed an empty string to
              show. Pre-existing, and newly reachable: clearing a field would
              otherwise land the reader on that same blank box. */}
          <SelectValue placeholder={placeholder || t('select_placeholder')} />
        </SelectTrigger>
        <SelectContent>
          {enumOptions.map((opt) => (
            <SelectItem key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {clearable && (
        <button
          type="button"
          // `emptyValue`, not a bare `undefined`, so this matches what the
          // text and textarea widgets already send when emptied — RJSF then
          // drops the key from formData rather than storing an empty string.
          onClick={() => onChange(options['emptyValue'])}
          aria-label={t('clear_selection')}
          title={t('clear_selection')}
          // `right-8` clears the chevron (px-3 padding + a 16px icon = 28px)
          // without depending on the trigger's own padding.
          className="absolute inset-y-0 right-8 my-auto flex h-6 w-6 items-center justify-center rounded-md text-(--bd-fg-muted) transition-colors hover:bg-(--bd-border-soft) hover:text-(--bd-fg) focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--bd-primary-50)"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
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

/**
 * Reads the `uiSchema` off one of `ObjectFieldTemplate`'s child slots.
 *
 * `properties[].content` is a `ReactElement`, and React 19's types default its
 * `props` to `unknown` (React 18 defaulted them to `any`), so the shape has to
 * be narrowed explicitly instead of being read straight off `.props`.
 *
 * @param content - The rendered child field element RJSF hands to the template.
 * @returns The child's `uiSchema`, or `undefined` when it carries none.
 */
function childUiSchema(content: ReactElement): Record<string, unknown> | undefined {
  return (content.props as { uiSchema?: Record<string, unknown> }).uiSchema;
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
  const visibleProperties = properties.filter(
    (p) => childUiSchema(p.content)?.['ui:widget'] !== 'hidden',
  );
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
          const span = (childUiSchema(p.content)?.['ui:colSpan'] as 1 | 2 | undefined) ?? 1;
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

/**
 * Reads the `itemLabel` ui option off an array field's own uiSchema.
 *
 * `ArrayFieldTemplate` sees this as `uiSchema`; `ArrayFieldItemTemplate` sees
 * the same object as `parentUiSchema` (its own `uiSchema` is the *item's*), so
 * both go through here to stay in step.
 *
 * @param uiSchema - The array field's uiSchema, if it declares one.
 * @returns The configured item noun, defaulting to `entry`.
 */
function arrayItemLabel(uiSchema: UiSchema | undefined): string {
  return (uiSchema?.['ui:options']?.['itemLabel'] as string | undefined) ?? 'entry';
}

/**
 * Per-item chrome for array fields: an "<Item> N" heading and a Remove button,
 * shown only once the array holds more than one entry.
 *
 * RJSF v6 renders array items through this template and hands
 * `ArrayFieldTemplate` the finished elements, so the item-level markup that
 * used to live inside the array template's `items.map()` belongs here now.
 *
 * @param props - v6 item props; uses `children`, `index`, `totalItems`,
 *   `buttonsProps.hasRemove` / `.onRemoveItem`, and `parentUiSchema`.
 * @returns One array row, with its header when the array has several rows.
 */
function ArrayFieldItemTemplate(props: ArrayFieldItemTemplateProps) {
  const { children, index, totalItems, buttonsProps, parentUiSchema } = props;
  const itemLabel = arrayItemLabel(parentUiSchema);
  const multiple = totalItems > 1;
  return (
    <div className="space-y-2">
      {multiple && (
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] font-semibold text-ink-500">
            {capitalise(itemLabel)} {index + 1}
          </span>
          {buttonsProps.hasRemove && (
            <button
              type="button"
              onClick={buttonsProps.onRemoveItem}
              className="text-[12.5px] text-rose-500 hover:text-rose-600"
            >
              Remove
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

function ArrayFieldTemplate(props: ArrayFieldTemplateProps) {
  const { title, items, canAdd, onAddClick, uiSchema } = props;
  const itemLabel = arrayItemLabel(uiSchema);
  return (
    <div className="space-y-3">
      {title && <h3 className="font-display font-bold text-[15px] text-ink-900">{title}</h3>}
      {/* v6 hands over already-rendered, already-keyed item elements. */}
      {items}
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
  ConsentCheckbox: ConsentCheckboxWidget,
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
  /**
   * Fired whenever schema-validity of the (visible, `x-show-if`-pruned) form
   * changes. `true` once every visible required field is filled and valid.
   * Lets callers gate a submit button's `disabled` without re-implementing
   * validation. Hidden fields are pruned before the check, so they never block.
   */
  onValidityChange?: (valid: boolean) => void;
}

export function RjsfThemedForm<T extends GenericObjectType = GenericObjectType>({
  className,
  showErrorList = false,
  liveValidate = false,
  noHtml5Validate = true,
  // `x-show-if` requires omitting hidden/pruned values so they never validate
  // or submit. Default both on; a caller may still override explicitly.
  omitExtraData = true,
  liveOmit = true,
  schema,
  formData,
  onChange,
  onValidityChange,
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

  // Apply `x-show-if`: prune fields whose control value doesn't match, clearing
  // their data. The pruned schema and cleared values feed RJSF directly so
  // hidden fields never render, validate, or submit.
  const currentData = (formData ?? {}) as Record<string, unknown>;
  const resolved = resolveVisibleSchema(schema as RJSFSchema, currentData);
  const hiddenKey = resolved.hidden.join('|');

  // Memoise the rendered schema on (schema identity, visible-set signature) so
  // its object identity is stable while the visible set is unchanged — otherwise
  // RJSF rebuilds fields on every keystroke and text inputs lose focus. Strip
  // `x-show-if` so Ajv never sees the custom keyword.
  // Keyed on (schema identity, visible-set signature): resolved.schema depends
  // only on those two, so recomputing with the latest `currentData` yields the
  // same pruned shape while keeping a stable identity across keystrokes.
  const renderSchema = useMemo(
    () => stripShowIf(resolveVisibleSchema(schema as RJSFSchema, currentData).schema),
    [schema, hiddenKey],
  );

  // Schema-validity of the visible (pruned) form. Drives a caller's submit
  // gate via onValidityChange. Computed against renderSchema + cleared data, so
  // `x-show-if`-hidden required fields are already excluded and never block.
  const isValid = validator.isValid(
    renderSchema as RJSFSchema,
    resolved.formData as T,
    renderSchema as RJSFSchema,
  );
  // Keep the callback in a ref so the emit effect fires only on validity flips,
  // not on every parent re-render that passes a fresh inline callback.
  const validityCb = useRef(onValidityChange);
  validityCb.current = onValidityChange;
  useEffect(() => {
    validityCb.current?.(isValid);
  }, [isValid]);

  return (
    <div className={className}>
      <Form<T>
        showErrorList={showErrorList}
        liveValidate={liveValidate}
        noHtml5Validate={noHtml5Validate}
        omitExtraData={omitExtraData}
        liveOmit={liveOmit}
        {...props}
        schema={renderSchema as RJSFSchema}
        formData={resolved.formData as T}
        onChange={(e: IChangeEvent<T>, id?: string) => {
          // Re-run the evaluator on the new values so hidden fields are cleared
          // before the change bubbles to the parent's controlled state.
          const next = (e.formData ?? {}) as Record<string, unknown>;
          const cleared = resolveVisibleSchema(schema as RJSFSchema, next).formData;
          onChange?.({ ...e, formData: cleared as T }, id);
        }}
        validator={validator}
        widgets={widgets}
        templates={{
          FieldTemplate,
          ObjectFieldTemplate,
          ArrayFieldTemplate,
          ArrayFieldItemTemplate,
          TitleFieldTemplate: TitleField,
        }}
      />
    </div>
  );
}
