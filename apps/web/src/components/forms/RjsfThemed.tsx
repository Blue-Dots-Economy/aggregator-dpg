'use client';

/**
 * The portal's RJSF form: `@rjsf/core`'s `Form` with the portal theme, the
 * Ajv 2020 validator and `x-show-if` handling.
 *
 * The widgets and templates live in `./rjsf-theme`.
 *
 * @module apps/web/components/forms/RjsfThemed
 */
import Form from '@rjsf/core';
import type { FormProps, IChangeEvent } from '@rjsf/core';
import { customizeValidator } from '@rjsf/validator-ajv8';
import Ajv2020 from 'ajv/dist/2020';
import type { GenericObjectType, RJSFSchema } from '@rjsf/utils';
import { useEffect, useMemo, useRef, type Ref } from 'react';
import { pruneHiddenFields, resolveVisibleSchema, stripShowIf } from '@/lib/show-if';
import { templates } from './rjsf-theme/templates';
import { widgets } from './rjsf-theme/widgets';

export interface RjsfThemedFormProps<T extends GenericObjectType = GenericObjectType> extends Omit<
  FormProps<T>,
  'validator' | 'widgets' | 'templates'
> {
  className?: string;
  /** The RJSF form instance, e.g. to call `validateForm()` from outside it. */
  ref?: Ref<Form<T>>;
  /**
   * Called when the validity of the visible form changes.
   *
   * `true` once every visible required field is valid. Hidden fields never block.
   */
  onValidityChange?: (valid: boolean) => void;
}

/**
 * Applies `x-show-if` to the form data: hidden fields' values are removed.
 *
 * @param schema - The form's full schema.
 * @param formData - The current form data.
 * @returns The visible form data and the names of the hidden fields.
 */
function resolveVisibleData<T extends GenericObjectType>(
  schema: RJSFSchema,
  formData: T | undefined,
): { formData: T; hidden: string[] } {
  const resolved = resolveVisibleSchema(schema, formData ?? {});
  // The result is a copy of `formData` with keys removed; a plain record cannot be narrowed to RJSF's generic `T`.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { formData: resolved.formData as T, hidden: resolved.hidden };
}

/**
 * Renders a schema-driven form with the portal's widgets and templates.
 *
 * Fields hidden by `x-show-if` are removed from the schema and their values are
 * cleared before `onChange` sees them, so they never validate or submit.
 *
 * @param props - RJSF form props, without `validator`, `widgets` or `templates`.
 * @returns The themed form.
 */
export function RjsfThemedForm<T extends GenericObjectType = GenericObjectType>({
  className,
  showErrorList = false,
  liveValidate = false,
  noHtml5Validate = true,
  // On by default so `x-show-if`-hidden values never validate or submit.
  omitExtraData = true,
  liveOmit = true,
  schema,
  formData,
  onChange,
  onValidityChange,
  ...props
}: RjsfThemedFormProps<T>) {
  // Uses Ajv's 2020 build because the schemas declare draft 2020-12.
  const validator = customizeValidator<T>({ AjvClass: Ajv2020 });

  // Apply `x-show-if`: hidden fields are removed and their values cleared.
  const resolved = resolveVisibleData(schema, formData);
  // Field names never hold a newline, so it separates them in the memo key.
  const hiddenKey = resolved.hidden.join('\n');

  // Memoised on the schema and the visible-field set so inputs keep focus
  // while typing. `x-show-if` is stripped so Ajv never sees it.
  const renderSchema = useMemo(
    () => stripShowIf(pruneHiddenFields(schema, hiddenKey === '' ? [] : hiddenKey.split('\n'))),
    [schema, hiddenKey],
  );

  // Validity of the visible form only.
  const isValid = validator.isValid(renderSchema, resolved.formData, renderSchema);
  // Ref so the effect fires only when validity changes.
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
        schema={renderSchema}
        formData={resolved.formData}
        onChange={(e: IChangeEvent<T>, id?: string) => {
          // Clear newly hidden fields before passing the change up.
          const cleared = resolveVisibleData(schema, e.formData).formData;
          onChange?.({ ...e, formData: cleared }, id);
        }}
        validator={validator}
        widgets={widgets}
        templates={templates}
      />
    </div>
  );
}
