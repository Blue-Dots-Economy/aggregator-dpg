'use client';

import { useMemo, type JSX } from 'react';
import type { ErrorSchema, RJSFSchema } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '@/components/forms/RjsfThemed';
import type { ResolvedPlace } from '@/components/forms/custom-widgets/LocationAutocompleteWidget';
import { readableFormErrors } from '@/lib/readable-form-errors';
import type { LinkIdentity } from '@/lib/registration-link';
import { birthYearOptions } from '../_lib/birth-year';
import { buildFormSchema, buildFormUiSchema } from '../_lib/form-schema';
import type { ItemLocation } from '../_lib/use-registration-submit';

/** Props for {@link ProfileForm}. */
export interface ProfileFormProps {
  /** The link's profile schema. */
  schema: RJSFSchema;
  /** The link's uiSchema. */
  uiSchema: Record<string, unknown>;
  identity: LinkIdentity | undefined;
  formData: Record<string, unknown>;
  onFormDataChange: (data: Record<string, unknown>) => void;
  /** Server field errors from the last submit, marked inline. */
  serverFieldErrors: ErrorSchema | undefined;
  /** Live validation and the error list are on after the first submit attempt. */
  showValidation: boolean;
  /** Called with the readable error lines when a submit fails validation. */
  onValidationFailed: (messages: string[]) => void;
  onSubmit: (values: Record<string, unknown>) => void;
  /** Coordinates the registrant picked; empty when nothing is picked. */
  onLocationsResolved: (coords: ItemLocation[]) => void;
  showBirthYear: boolean;
  yearOfBirth: string;
  onYearOfBirthChange: (value: string) => void;
  /** Whether the year of birth is a valid year. */
  yearOfBirthValid: boolean;
  /** Shows the under-18 notice in place of consent. */
  showMinorNotice: boolean;
  submitting: boolean;
  brandColor: string | undefined;
}

/**
 * Full-profile registration form: the RJSF fields, the birth-year select and
 * the submit button.
 *
 * Submit is never disabled by an invalid field: the click validates, reveals
 * errors and reports them through `onValidationFailed`.
 */
export function ProfileForm(props: Readonly<ProfileFormProps>): JSX.Element {
  const t = useTranslations('profile.public_reg');
  const { schema, uiSchema, identity, serverFieldErrors, showValidation } = props;
  const formSchema = useMemo(() => buildFormSchema(schema, identity), [schema, identity]);
  const formUiSchema = useMemo(() => buildFormUiSchema(schema, uiSchema), [schema, uiSchema]);
  const currentYear = new Date().getFullYear();
  // Only an in-flight submit and, when collected, an invalid birth year block
  // the button. Consent opens a gate on submit instead.
  const blocked = props.submitting || (props.showBirthYear && !props.yearOfBirthValid);

  return (
    <RjsfThemedForm
      schema={formSchema}
      uiSchema={formUiSchema}
      formData={props.formData}
      // Location widgets report resolved coordinates here; they read it as
      // `registry.formContext`, not as a prop.
      formContext={{
        // Keep only lat/lng from the richer `ResolvedPlace`.
        onLocationResolved: (place: ResolvedPlace | null) =>
          props.onLocationsResolved(place ? [{ lat: place.lat, lng: place.lng }] : []),
        // The multi-value widget already emits this shape.
        onLocationsResolved: (coords: ItemLocation[]) => props.onLocationsResolved(coords),
      }}
      onChange={(e) => props.onFormDataChange(e.formData ?? {})}
      onSubmit={(e) => props.onSubmit(e.formData ?? {})}
      liveValidate={showValidation}
      showErrorList={showValidation ? 'top' : false}
      focusOnFirstError
      noHtml5Validate
      transformErrors={(errors) => readableFormErrors(errors, formSchema)}
      {...(serverFieldErrors ? { extraErrors: serverFieldErrors } : {})}
      onError={(errors) => props.onValidationFailed(errors.map((e) => e.stack))}
    >
      <div className="mt-4 flex flex-col gap-3">
        {props.showBirthYear && (
          <label className="block">
            <span className="text-[14px] font-medium text-(--bd-fg)">
              {t('year_of_birth_label')}
              <span className="text-rose-500 ml-0.5">*</span>
            </span>
            <select
              value={props.yearOfBirth}
              onChange={(e) => props.onYearOfBirthChange(e.target.value)}
              className="mt-1 w-full rounded-[10px] border border-(--bd-border) px-3 py-2 text-[14px]"
              required
            >
              <option value="">{t('year_of_birth_placeholder')}</option>
              {birthYearOptions(currentYear).map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </select>
          </label>
        )}
        {props.showMinorNotice && (
          // Minor: no consent here; they accept terms in the Signalstack app
          // later. Submit still proceeds.
          <div className="rounded-[12px] border border-(--bd-border) bg-(--bd-primary-50) px-4 py-3.5 text-[14px] text-(--bd-fg)">
            {t('u18_notice')}
          </div>
        )}
        <button
          type="submit"
          disabled={blocked}
          // Same background and text colour in both states; disabled only
          // lowers opacity.
          style={{ backgroundColor: props.brandColor }}
          className={`w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white transition-all
                    ${blocked ? 'cursor-not-allowed opacity-60' : 'hover:opacity-90 bd-shadow-lg'}`}
        >
          {props.submitting ? t('btn_submitting') : t('btn_submit')}
        </button>
      </div>
    </RjsfThemedForm>
  );
}
