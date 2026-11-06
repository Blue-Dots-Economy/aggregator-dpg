/**
 * The RJSF theme's field wrapper: label, required marker, description and errors.
 *
 * @module apps/web/components/forms/rjsf-theme/FieldTemplate
 */
import type { FieldTemplateProps } from '@rjsf/utils';

/**
 * Wraps one field with its label, description and errors.
 *
 * A `ui:widget: hidden` field renders nothing. Objects and arrays render only
 * their children and errors; an array with a custom widget is treated as one input.
 *
 * @param props - RJSF field template props.
 * @returns The wrapped field, or `null` for a hidden field.
 */
export function FieldTemplate(props: FieldTemplateProps) {
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
  // Array fields with a custom `ui:widget` render as one input, so treat them as leaves.
  const customWidget = uiSchema?.['ui:widget'];
  const arrayAsLeaf =
    schema.type === 'array' && typeof customWidget === 'string' && customWidget !== 'hidden';
  const isContainer = (schema.type === 'object' || schema.type === 'array') && !arrayAsLeaf;
  const hasError = Array.isArray(rawErrors) && rawErrors.length > 0;
  // Red border on any `.bd-input` inside an invalid field.
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
