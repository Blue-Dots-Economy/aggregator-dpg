/**
 * Identity-only registration form for links with `submission_shape === 'account_only'`.
 *
 * Collects name, phone or email, and optional consent and birth year. The
 * parent passes the network's identity field names so the payload uses the
 * right keys for the domain.
 */
'use client';

import { useEffect, useState, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import type { LinkIdentity } from '@/lib/registration-link';
import {
  FieldMessage,
  useHandFieldErrors,
  type HandFieldError,
} from '../../../components/forms/useHandFieldErrors';
import { PhoneInput } from '../../../components/forms/PhoneInput';
import { isValidPhone, phoneValueMode } from '../../../lib/phone';
import { useFieldErrorCopy } from '../../../components/forms/useFieldErrors';

type IdentityField = 'name' | 'year_of_birth' | 'phone' | 'email' | 'consent_call';

export interface MinimalIdentityPayload {
  /** Name field. Key is the network's `identity.name` selector. */
  [name: string]: string | boolean;
}

export interface MinimalIdentityFormProps {
  /**
   * Identity field names from the network config, used as payload keys.
   * An undefined `phone` or `email` hides that input.
   */
  identity: LinkIdentity;
  /** Submit handler; receives the identity-only payload. */
  onSubmit: (payload: MinimalIdentityPayload) => void | Promise<void>;
  /**
   * Disables the submit button while the parent's submit is in flight. This
   * is the form's only in-flight guard; it has no local `submitting` state.
   */
  busy?: boolean;
  /** Brand colour for the header band and submit button. Defaults to `var(--bd-primary-600)`. */
  brandColor?: string;
  /** Optional i18n key (root namespace) for a hint below the form. */
  hintI18nKey?: string | null;
  /**
   * Voice mode: phone is required and email is optional. When false
   * (default), name plus phone or email is required.
   */
  /** The phone field's schema `pattern`; bare 10-digit patterns store no country code. */
  phonePattern?: string | undefined;
  requirePhone?: boolean;
  /**
   * Show the consent checkbox. Set when the domain's `go_live_required`
   * includes `consent_required`.
   */
  showConsent: boolean;
  /**
   * Collect a birth year. Set when the domain has `guardian_consent_required`.
   */
  showBirthYear: boolean;
  /** Server messages keyed by payload key (identity selectors or `year_of_birth`). */
  serverErrors?: Readonly<Record<string, string>> | null;
}

/**
 * Checks whether a value looks like an email, for the inline field message.
 *
 * Requires one `@`, no whitespace, and a dot inside the domain. Uses index
 * scans instead of a regex to avoid slow backtracking. The server does the
 * real validation.
 *
 * @param value - Trimmed contents of the email field.
 * @returns True when the value is plausibly an email address.
 */
function looksLikeEmail(value: string): boolean {
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  if (domain.length === 0) return false;
  if (/\s/.test(value)) return false;
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

export function MinimalIdentityForm(props: MinimalIdentityFormProps): JSX.Element {
  const t = useTranslations('profile.public_reg.account_only');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [yearOfBirth, setYearOfBirth] = useState('');
  const [consentCall, setConsentCall] = useState(false);

  const nameKey = props.identity.name;
  const phoneKey = props.identity.phone;
  const emailKey = props.identity.email;
  const requirePhone = !!props.requirePhone;
  // Email is always shown when the domain declares it. In voice mode phone is
  // mandatory and email is optional; otherwise phone OR email is required.
  const showEmail = !!emailKey;

  // Requires a name and, in voice mode, a valid phone; otherwise a valid phone
  // or email.
  const hasName = name.trim().length > 0;
  const hasPhone = !!phoneKey && phone.trim().length > 0;
  const hasEmail = showEmail && email.trim().length > 0;
  const phoneFormatOk = isValidPhone(phone);
  const emailFormatOk = looksLikeEmail(email.trim());
  const phoneValid = hasPhone && phoneFormatOk;
  const emailValid = hasEmail && emailFormatOk;
  const contactValid = requirePhone ? phoneValid : phoneValid || emailValid;
  // Age is derived from the birth year; no birthdate is stored. Guardian-gated
  // domains need it, or Signals rejects the submit with `AGE_REQUIRED`.
  const currentYear = new Date().getFullYear();
  const yobNum = Number(yearOfBirth.trim());
  const yobValid =
    /^\d{4}$/.test(yearOfBirth.trim()) && yobNum >= currentYear - 120 && yobNum <= currentYear;
  const derivedAge = yobValid ? currentYear - yobNum : Number.NaN;
  // Minors (age <= 18) do not give consent here; they accept terms in the
  // Signalstack app after signing in. The submit still goes through.
  const isMinor = yobValid && derivedAge <= 18;

  const copy = useFieldErrorCopy();
  const required = (message: string): HandFieldError => ({ kind: 'required', message });
  const invalid = (message: string): HandFieldError => ({
    kind: 'invalid',
    message: copy.invalid(message),
  });
  const phoneError: HandFieldError | null =
    hasPhone && !phoneFormatOk
      ? invalid(t('errors.phone_invalid'))
      : requirePhone && !hasPhone
        ? required(copy.required(t('phone_label')))
        : !requirePhone && !contactValid && !hasEmail && phoneKey
          ? required(t('errors.contact_required'))
          : null;
  const emailError: HandFieldError | null =
    hasEmail && !emailFormatOk
      ? invalid(t('errors.email_invalid'))
      : !requirePhone && !contactValid && !hasPhone && !phoneKey
        ? required(t('errors.contact_required'))
        : null;
  const fe = useHandFieldErrors<IdentityField>('account-only', {
    name: hasName ? null : required(copy.required(t('name_label'))),
    year_of_birth:
      props.showBirthYear && !yobValid ? required(copy.required(t('year_of_birth_label'))) : null,
    phone: phoneError,
    email: emailError,
    consent_call:
      props.showConsent && !isMinor && !consentCall
        ? required(copy.required(t('errors.consent_call')))
        : null,
  });

  const { setServerErrors } = fe;
  const serverErrors = props.serverErrors;
  useEffect(() => {
    if (!serverErrors) return;
    const byField: Partial<Record<IdentityField, string>> = {};
    for (const [key, message] of Object.entries(serverErrors)) {
      if (key === nameKey) byField.name = message;
      else if (key === phoneKey) byField.phone = message;
      else if (key === emailKey) byField.email = message;
      else if (key === 'year_of_birth') byField.year_of_birth = message;
    }
    setServerErrors(byField);
  }, [serverErrors]);

  return (
    <div className="rounded-[18px] bg-white border border-(--bd-border) overflow-hidden shadow-[0_1px_0_rgba(11,16,32,0.02),0_20px_60px_-30px_rgba(11,16,32,0.18)]">
      <div
        className="px-6 sm:px-8 py-6 text-white"
        style={{ background: props.brandColor ?? 'var(--bd-primary-600)' }}
      >
        <h1 className="font-display font-bold text-[22px] sm:text-[26px] tracking-tight leading-tight">
          {t('title')}
        </h1>
        <p className="text-[13.5px] text-white/85 mt-1.5">{t('helper')}</p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (props.busy || !fe.validate() || !nameKey) return;
          const payload: MinimalIdentityPayload = {
            [nameKey]: name.trim(),
            // Send the birth year only when the domain collects it. The parent
            // view adds `consent_terms` / `consent_privacy` after its consent
            // gate. `consentCall` is permission to call the registrant, not
            // terms/privacy acceptance.
            ...(props.showBirthYear ? { year_of_birth: yearOfBirth.trim() } : {}),
          };
          if (phoneKey && hasPhone) payload[phoneKey] = phone.trim();
          if (emailKey && hasEmail) payload[emailKey] = email.trim();
          void props.onSubmit(payload);
        }}
        noValidate
        className="px-6 sm:px-8 py-7 flex flex-col gap-5"
      >
        <div>
          <label className="block">
            <span className="bd-label">
              {t('name_label')}
              <span className="text-rose-500 ml-0.5">*</span>
            </span>
            <input
              className="bd-input"
              type="text"
              {...fe.controlProps('name')}
              name={nameKey ?? 'name'}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                fe.clearServer('name');
              }}
              required
              autoComplete="name"
            />
          </label>
          <FieldMessage id={fe.errorId('name')} message={fe.message('name')} />
        </div>

        {props.showBirthYear && (
          <div>
            <label className="block">
              <span className="bd-label">
                {t('year_of_birth_label')}
                <span className="text-rose-500 ml-0.5">*</span>
              </span>
              <select
                className="bd-input"
                {...fe.controlProps('year_of_birth')}
                name="year_of_birth"
                value={yearOfBirth}
                onChange={(e) => {
                  setYearOfBirth(e.target.value);
                  fe.clearServer('year_of_birth');
                }}
                required
              >
                <option value="">{t('year_of_birth_placeholder')}</option>
                {Array.from({ length: 101 }, (_, i) => currentYear - i).map((y) => (
                  <option key={y} value={String(y)}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <FieldMessage id={fe.errorId('year_of_birth')} message={fe.message('year_of_birth')} />
          </div>
        )}

        {(phoneKey || showEmail) && (
          <div>
            {!requirePhone && (
              <div className="text-[12px] text-ink-500 mb-2">{t('contact_label')}</div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {phoneKey && (
                <div>
                  <label className="block" htmlFor={fe.controlProps('phone').id}>
                    <span className="bd-label">
                      {t('phone_label')}
                      {requirePhone && <span className="text-rose-500 ml-0.5">*</span>}
                    </span>
                  </label>
                  <PhoneInput
                    id={fe.controlProps('phone').id}
                    nationalOnly={phoneValueMode(props.phonePattern) === 'national'}
                    value={phone}
                    onChange={(next) => {
                      setPhone(next ?? '');
                      fe.clearServer('phone');
                    }}
                    onBlur={fe.controlProps('phone').onBlur}
                    inputProps={{
                      ...fe.controlProps('phone'),
                      ...(phoneKey ? { name: phoneKey } : {}),
                    }}
                    required={requirePhone}
                  />
                  <FieldMessage id={fe.errorId('phone')} message={fe.message('phone')} />
                </div>
              )}
              {showEmail && (
                <div>
                  <label className="block">
                    <span className="bd-label">{t('email_label')}</span>
                    <input
                      className="bd-input"
                      type="email"
                      {...fe.controlProps('email')}
                      name={emailKey}
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        fe.clearServer('email');
                      }}
                      autoComplete="email"
                      placeholder="you@example.com"
                    />
                  </label>
                  <FieldMessage id={fe.errorId('email')} message={fe.message('email')} />
                </div>
              )}
            </div>
          </div>
        )}

        {props.showConsent &&
          (isMinor ? (
            // Minor: no consent here; they accept terms in the Signalstack app later.
            <div className="rounded-[10px] border border-(--bd-border) bg-(--bd-primary-50) px-4 py-3.5 text-[13.5px] text-ink-900">
              {t('u18_notice')}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5 pt-1">
              <label className="flex items-start gap-2.5 text-[13px] text-ink-900 cursor-pointer">
                <input
                  type="checkbox"
                  {...fe.controlProps('consent_call')}
                  name="consent_call"
                  checked={consentCall}
                  onChange={(e) => setConsentCall(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded-sm border-(--bd-border) accent-(--bd-primary-600)"
                />
                <span>{t('consent_call_label')}</span>
              </label>
              <FieldMessage id={fe.errorId('consent_call')} message={fe.message('consent_call')} />
            </div>
          ))}

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={props.busy}
            style={{ background: props.brandColor ?? undefined }}
            className="inline-flex items-center justify-center rounded-[10px] px-5 py-2.5 text-[14px] font-semibold text-white bg-(--bd-primary-600) hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {t('submit_label')}
          </button>
        </div>
      </form>
    </div>
  );
}
