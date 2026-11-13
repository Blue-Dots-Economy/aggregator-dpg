'use client';

/**
 * Shared UI pieces and hooks for the coordinator and org registration forms.
 * Belongs to `@aggregator-dpg/web`.
 *
 * @module apps/web/src/app/(public)/register/registration-ui
 */

import { useEffect, useRef, useState, type RefObject, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import type { IChangeEvent } from '@rjsf/core';
import type { FormValidation } from '@rjsf/utils';
import { refusedNameCharacters } from '@aggregator-dpg/shared-primitives/person-name';
import type { ConsentDoc } from '../../../components/consent/consent-docs';
import type { ConsentDocContent } from '../../../components/consent/consent-types';
import type { ResolvedPlace } from '../../../components/forms/custom-widgets/LocationAutocompleteWidget';
import { useFieldErrorCopy, type FieldErrors } from '@/components/forms/useFieldErrors';
import { requestErrorKind } from '@/lib/request-errors';
import type { SubmitError, SubmitState } from './registration-shared';

/** Local form lifecycle shared by the coordinator + org registration forms. */
export interface RegistrationFormState {
  state: SubmitState;
  setState: (s: SubmitState) => void;
  /** Ref to the error banner; `null` until it mounts. */
  errorRef: RefObject<HTMLDivElement | null>;
}

/**
 * Whether a state needs the error banner.
 *
 * @param state - The form's submit state.
 */
export function showsErrorBanner(
  state: SubmitState,
): state is Extract<SubmitState, { status: 'error' }> {
  return state.status === 'error';
}

/**
 * Holds the submit state and the error banner ref.
 *
 * On failure the error banner is scrolled into view and focused; server field
 * errors are focused by `setServerErrors`.
 *
 * @returns The form state handles.
 */
export function useRegistrationFormState(): RegistrationFormState {
  const [state, setState] = useState<SubmitState>({ status: 'idle' });
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.status !== 'error') return;
    const target = errorRef.current;
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.focus({ preventScroll: true });
  }, [state]);
  return { state, setState, errorRef };
}

/** Dot paths of the form fields a registration API error can name. */
export interface RegistrationFieldPaths {
  email: string;
  phone: string;
  /** Organisation name, for the org form. */
  name?: string;
}

/**
 * Turns a rejected registration into field errors, else one readable banner.
 *
 * @param paths - Where the email, phone and name fields live in the form data.
 * @param bannerKeys - Extra `register.*` message keys for specific API codes.
 */
export function useRegistrationError(
  fieldErrors: FieldErrors,
  paths: RegistrationFieldPaths,
  bannerKeys: Readonly<Record<string, string>> = {},
): (error: SubmitError) => SubmitState {
  const t = useTranslations('register');
  const tRequest = useTranslations('form.request_error');
  const tForm = useTranslations('form');
  const copy = useFieldErrorCopy();
  return (error) => {
    const onField: Record<string, string> = {};
    if (error.code === 'USER_EXISTS' || error.code === 'OWNER_ALREADY_REGISTERED') {
      onField[paths.email] = t('error_email_exists');
    } else if (error.code === 'PHONE_EXISTS') {
      onField[paths.phone] = t('error_phone_exists');
    } else if (error.code === 'INVALID_PHONE') {
      onField[paths.phone] = copy.invalid(t('error_phone_invalid'));
    } else if (error.code === 'ORG_NAME_TAKEN' && paths.name) {
      onField[paths.name] = t('error_org_name_taken');
    }
    // Field messages and the code's own message are placed together, so neither overwrites the other.
    const { complete, unmapped } = fieldErrors.setServerErrors(error.fields, onField);
    if (complete) return { status: 'idle' };
    const key = bannerKeyFor(error.code, bannerKeys);
    const status = error.status ?? 0;
    const reference =
      status >= 500 && error.requestId ? [tForm('request_reference', { id: error.requestId })] : [];
    return {
      status: 'error',
      title: key ? t(key) : tRequest(requestErrorKind(status)),
      // Messages no field on this form owns, and the request id support needs for a server fault.
      detail: [...unmapped, ...reference].join('\n'),
      code: error.code,
      requestId: error.requestId,
    };
  };
}

/** The `register.*` banner key for an API code: the form's own keys first, then the shared ones. */
function bannerKeyFor(code: string, own: Readonly<Record<string, string>>): string | undefined {
  if (Object.hasOwn(own, code)) return own[code];
  if (Object.hasOwn(REGISTRATION_BANNER_KEYS, code)) return REGISTRATION_BANNER_KEYS[code];
  return undefined;
}

/** `register.*` banner messages for API codes that name no field. */
const REGISTRATION_BANNER_KEYS: Readonly<Record<string, string>> = {
  REGISTRATION_COOLING: 'error_cooling',
  TARGET_ORG_INACTIVE: 'error_org_inactive',
  INVITE_ALREADY_USED: 'error_invite_used',
};

/** Submit flow that holds the form values until consent is accepted. */
export interface ConsentGateSubmit {
  /** True while the blocking consent gate is open. */
  gateOpen: boolean;
  /** Opens/closes the gate — `false` on cancel and once consent is accepted. */
  setGateOpen: (open: boolean) => void;
  /** Form values parked at submit, replayed once consent is accepted. */
  pendingRef: RefObject<Record<string, unknown> | null>;
  /** RJSF `onSubmit`: parks the payload, then opens the gate. */
  handleSubmit: (e: IChangeEvent<Record<string, unknown>>) => void;
}

/**
 * Holds the form values on submit and opens the consent gate.
 *
 * The caller's accept handler posts the held values. When `consentDocs` is
 * empty (loading failed), it sets an error instead of opening the gate.
 *
 * @param consentDocs - Ordered consent documents; empty when loading failed.
 * @param setState - Submit-lifecycle setter from {@link useRegistrationFormState}.
 * @returns The gate flag, its setter, the parked payload, and the RJSF handler.
 */
export function useConsentGateSubmit(
  consentDocs: ConsentDoc[],
  setState: (s: SubmitState) => void,
): ConsentGateSubmit {
  const t = useTranslations('register');
  const [gateOpen, setGateOpen] = useState(false);
  const pendingRef = useRef<Record<string, unknown> | null>(null);

  const handleSubmit = (e: IChangeEvent<Record<string, unknown>>): void => {
    pendingRef.current = (e.formData ?? {}) as Record<string, unknown>;
    if (consentDocs.length === 0) {
      setState({
        status: 'error',
        title: t('consent.load_failed_title'),
        detail: t('consent.load_failed_detail'),
        code: 'CONSENT_UNAVAILABLE',
        requestId: '',
      });
      return;
    }
    setGateOpen(true);
  };

  return { gateOpen, setGateOpen, pendingRef, handleSubmit };
}

/** What {@link sharedRegistrationFormProps} needs from the calling form. */
export interface SharedFormWiring {
  formData: Record<string, unknown>;
  setFormData: (data: Record<string, unknown>) => void;
  handleSubmit: (e: IChangeEvent<Record<string, unknown>>) => void;
  /** Error timing, messages and server field errors from `useFieldErrors`. */
  fieldErrors: FieldErrors;
  // `| undefined` is required by `exactOptionalPropertyTypes`; callers pass it explicitly.
  consentContent?: ConsentDocContent | undefined;
  /** Where the address widget reports the coordinate it resolved. */
  onLocationResolved: (place: ResolvedPlace | null) => void;
  /**
   * The person's name field (a dotted path such as `owner.name`) and the
   * message for symbols the sign-in system refuses, given those symbols.
   */
  personName?: { path: string; message: (symbols: string) => string } | undefined;
  /** The form's own checks; they run before the name check, not instead of it. */
  customValidate?: FormValidator | undefined;
}

type FormValidator = (
  data: Record<string, unknown> | undefined,
  errors: FormValidation,
) => FormValidation;

/** The form's own checks and the name check, run one after the other. */
function combinedValidator(wiring: SharedFormWiring): FormValidator | null {
  const checks = [
    wiring.customValidate,
    wiring.personName ? personNameValidator(wiring.personName) : undefined,
  ].filter((c): c is FormValidator => c !== undefined);
  if (checks.length === 0) return null;
  return (data, errors) => checks.reduce((acc, check) => check(data, acc), errors);
}

/**
 * Adds an error to the person's name field when it holds a symbol the sign-in
 * system refuses, so the form shows it on that field instead of failing later.
 */
function personNameValidator(
  personName: NonNullable<SharedFormWiring['personName']>,
): (data: Record<string, unknown> | undefined, errors: FormValidation) => FormValidation {
  return (data, errors) => {
    const keys = personName.path.split('.');
    let value: unknown = data;
    let field: unknown = errors;
    for (const k of keys) {
      value = (value as Record<string, unknown> | undefined)?.[k];
      field = (field as Record<string, unknown> | undefined)?.[k];
    }
    const symbols = typeof value === 'string' ? refusedNameCharacters(value) : [];
    if (symbols.length > 0 && field && typeof (field as FormValidation).addError === 'function') {
      (field as FormValidation).addError(personName.message(symbols.join(' ')));
    }
    return errors;
  };
}

/**
 * Builds the RJSF props the coordinator and org registration forms share.
 *
 * Spread the result onto `<RjsfThemedForm>`. The caller passes `schema` and `uiSchema`.
 *
 * @param wiring - The calling form's state setters, schema and copy.
 * @returns Props to spread onto the themed RJSF form.
 */
export function sharedRegistrationFormProps(wiring: SharedFormWiring): FieldErrors['formProps'] & {
  formData: Record<string, unknown>;
  formContext: Record<string, unknown>;
  onChange: (e: IChangeEvent<Record<string, unknown>>, id?: string) => void;
  onSubmit: (e: IChangeEvent<Record<string, unknown>>) => void;
  customValidate?: FormValidator;
  showErrorList: false;
  focusOnFirstError: true;
  noHtml5Validate: true;
} {
  const validate = combinedValidator(wiring);
  return {
    ...wiring.fieldErrors.formProps,
    formData: wiring.formData,
    // Widgets read this as `registry.formContext`, not as a prop.
    formContext: {
      consentContent: wiring.consentContent,
      onLocationResolved: wiring.onLocationResolved,
    },
    onChange: (e, id) => {
      wiring.setFormData(e.formData as Record<string, unknown>);
      wiring.fieldErrors.onFormChange(id, { before: wiring.formData, after: e.formData });
    },
    onSubmit: wiring.handleSubmit,
    // The person-name check runs alongside RJSF; its message shows under the name field.
    ...(validate ? { customValidate: validate } : {}),
    showErrorList: false,
    focusOnFirstError: true,
    noHtml5Validate: true,
  };
}

export interface RegistrationSubmitButtonProps {
  /** True while a submit is in flight. */
  submitting: boolean;
  /** Runs before the form validates, so every field shows its error. */
  onAttempt: () => void;
  /** Idle button label. */
  label: string;
  /** In-flight button label. */
  submittingLabel: string;
}

/**
 * Primary submit button shared by both registration forms. Disabled only
 * while a submit is in flight; a click shows each field's own error.
 *
 * @param props - Submitting flag, attempt callback and labels.
 * @returns The submit button.
 */
export function RegistrationSubmitButton({
  submitting,
  onAttempt,
  label,
  submittingLabel,
}: RegistrationSubmitButtonProps): JSX.Element {
  const disabled = submitting;
  return (
    <div className="mt-4 flex flex-col gap-3">
      <button
        type="submit"
        disabled={disabled}
        onClick={onAttempt}
        // One background and one text colour in both states; disabled only
        // lowers opacity. Two conflicting text-colour classes would resolve by
        // Tailwind stylesheet order, not class order.
        className={`w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white bg-(--bd-primary) transition-all
          ${
            disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-(--bd-primary-600) bd-shadow-lg'
          }`}
      >
        {submitting ? submittingLabel : label}
      </button>
    </div>
  );
}

export interface RegistrationErrorBannerProps {
  /** Banner heading (error title). */
  title: string;
  /** Newline-separated error lines rendered as a bullet list. */
  detail: string;
  /** Focus/scroll target so the banner can be pulled into view on submit. */
  errorRef: RefObject<HTMLDivElement | null>;
}

/**
 * Red alert banner shown when the server rejects a submit.
 *
 * @param props - Title, detail lines and focus ref.
 * @returns The error banner element.
 */
export function RegistrationErrorBanner({
  title,
  detail,
  errorRef,
}: RegistrationErrorBannerProps): JSX.Element {
  return (
    <div
      ref={errorRef}
      role="alert"
      tabIndex={-1}
      className="mb-5 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700 scroll-mt-6 outline-hidden"
    >
      <div className="font-semibold">{title}</div>
      {detail ? (
        <ul className="mt-1.5 text-red-600 list-disc list-inside space-y-0.5">
          {detail
            .split('\n')
            .filter(Boolean)
            .map((line, i) => (
              <li key={i}>{line}</li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
