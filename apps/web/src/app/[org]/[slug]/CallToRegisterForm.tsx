'use client';

/**
 * "Call to register" form of the two-option public registration page (web
 * app, public registration). Collects the domain's minimum identity fields
 * (name, phone and, where the domain gates on age, birth year), the terms
 * checkbox, and shows the voice bot's number before the participant submits.
 */

import { useState, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import type { ConsentDocContent } from '@/components/consent/consent-types';
import { ConsentModal, type ConsentTab } from '@/components/consent/ConsentModal';
import {
  FieldMessage,
  useHandFieldErrors,
  type HandFieldError,
} from '@/components/forms/useHandFieldErrors';
import { useFieldErrorCopy } from '@/components/forms/useFieldErrors';
import { PhoneInput } from '@/components/forms/PhoneInput';
import { SelectField } from '@/components/ui/SelectField';
import { I } from '@/icons';
import { usePhoneCountries } from '@/lib/FormRuntimeConfigProvider';
import { formatPhoneForReading, isAcceptedPhone, phoneValueMode } from '@/lib/phone';
import { isMinorBirthYear, isValidBirthYear } from '@/lib/registration-gates';
import type { LinkIdentity } from '@/lib/registration-link';

/** Birth years offered: this year and the 100 before it, the same list as the full registration form. */
const BIRTH_YEAR_CHOICES = 101;

type CallField = 'name' | 'phone' | 'year_of_birth' | 'terms';

/** Identity fields keyed by the network's selectors, plus `year_of_birth` when collected. */
export type CallPayload = Record<string, string>;

/** Props of {@link CallToRegisterForm}. */
export interface CallToRegisterFormProps {
  /** Identity field names from the network config, used as payload keys. */
  identity: LinkIdentity;
  /** Field labels from the link's schema; the generic label is used when absent. */
  labels: { name?: string | undefined; phone?: string | undefined };
  /** The phone field's schema `pattern`; bare 10-digit patterns store no country code. */
  phonePattern?: string | undefined;
  /** Collect a birth year (the domain needs guardian consent for minors). */
  showBirthYear: boolean;
  /** Show the terms checkbox (the domain gates on consent). */
  showTerms: boolean;
  /** Terms and Privacy text for the links in the checkbox label; plain text when null. */
  consentContent: ConsentDocContent | null;
  /** The voice bot: its name, number and the languages it speaks, already joined. */
  bot: { display_name: string; phone: string; languages: string };
  /** Called with the identity fields once every field is valid. */
  onSubmit: (payload: CallPayload) => void;
  /** Called whenever the chosen birth year makes the participant a minor or stops doing so. */
  onMinorChange: (minor: boolean) => void;
  /** Disables the submit button while the parent's request is in flight. */
  busy: boolean;
  /** Server messages keyed by payload key (identity selectors or `year_of_birth`). */
  serverErrors?: Readonly<Record<string, string>> | null;
  /** Brand colour of the submit button. */
  brandColor: string;
}

/**
 * Renders the "Call to register" form.
 *
 * A minor's birth year hides the number, the terms and the submit button; the
 * parent shows the under-18 notice.
 *
 * @param props - Identity keys, labels, gates, the bot and callbacks.
 * @returns The form.
 */
export function CallToRegisterForm(props: Readonly<CallToRegisterFormProps>): JSX.Element {
  const t = useTranslations('profile.public_reg.call');
  const tRegister = useTranslations('register');
  const copy = useFieldErrorCopy();
  const phoneCountries = usePhoneCountries();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [yearOfBirth, setYearOfBirth] = useState('');
  const [terms, setTerms] = useState(false);
  const [modalTab, setModalTab] = useState<ConsentTab | null>(null);

  const nameKey = props.identity.name;
  const phoneKey = props.identity.phone;
  const nameLabel = props.labels.name ?? t('name_label');
  const phoneLabel = props.labels.phone ?? t('phone_label');
  const currentYear = new Date().getFullYear();
  const minor = props.showBirthYear && isMinorBirthYear(yearOfBirth, currentYear);

  const required = (label: string): HandFieldError => ({
    kind: 'required',
    message: copy.required(label),
  });
  const phoneError = ((): HandFieldError | null => {
    if (phone.trim().length === 0) return required(phoneLabel);
    if (!isAcceptedPhone(phone, phoneCountries))
      return { kind: 'invalid', message: copy.invalid(t('phone_invalid')) };
    return null;
  })();
  const fe = useHandFieldErrors<CallField>('call-register', {
    name: name.trim().length > 0 ? null : required(nameLabel),
    phone: phoneError,
    year_of_birth:
      props.showBirthYear && !isValidBirthYear(yearOfBirth, currentYear)
        ? required(t('year_of_birth_label'))
        : null,
    terms:
      props.showTerms && !minor && !terms
        ? { kind: 'required', message: t('terms_required') }
        : null,
  });

  // New server messages from the parent are applied once, while rendering.
  const serverErrors = props.serverErrors;
  const [appliedServerErrors, setAppliedServerErrors] = useState<typeof serverErrors>(null);
  if (serverErrors !== appliedServerErrors) {
    setAppliedServerErrors(serverErrors);
    if (serverErrors) {
      const byField: Partial<Record<CallField, string>> = {};
      for (const [key, message] of Object.entries(serverErrors)) {
        if (key === nameKey) byField.name = message;
        else if (key === phoneKey) byField.phone = message;
        else if (key === 'year_of_birth') byField.year_of_birth = message;
      }
      fe.setServerErrors(byField);
    }
  }

  const chooseYear = (value: string): void => {
    setYearOfBirth(value);
    fe.clearServer('year_of_birth');
    props.onMinorChange(isMinorBirthYear(value, currentYear));
  };

  const termsLinkClass = 'text-(--bd-primary-600) underline hover:opacity-80 cursor-pointer';
  const termsLabel = props.consentContent ? (
    <span>
      {tRegister('consent.accept_prefix')}
      <button type="button" className={termsLinkClass} onClick={() => setModalTab('privacy')}>
        {tRegister('consent.privacy_link')}
      </button>
      {tRegister('consent.and')}
      <button type="button" className={termsLinkClass} onClick={() => setModalTab('terms')}>
        {tRegister('consent.terms_link')}
      </button>
    </span>
  ) : (
    <span>
      {tRegister('consent.accept_prefix')}
      {tRegister('consent.privacy_link')}
      {tRegister('consent.and')}
      {tRegister('consent.terms_link')}
    </span>
  );

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (props.busy || minor || !fe.validate() || !nameKey || !phoneKey) return;
          props.onSubmit({
            [nameKey]: name.trim(),
            [phoneKey]: phone.trim(),
            ...(props.showBirthYear ? { year_of_birth: yearOfBirth.trim() } : {}),
          });
        }}
        noValidate
        className="flex flex-col gap-5"
      >
        <h2 className="font-display font-bold text-[19px] text-(--bd-fg) tracking-tight">
          {t('title')}
        </h2>

        <div>
          <label className="block">
            <span className="bd-label">
              {nameLabel}
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

        <div>
          <label className="block" htmlFor={fe.controlProps('phone').id}>
            <span className="bd-label">
              {phoneLabel}
              <span className="text-rose-500 ml-0.5">*</span>
            </span>
          </label>
          <PhoneInput
            id={fe.controlProps('phone').id}
            nationalOnly={phoneValueMode(props.phonePattern, phoneCountries) === 'national'}
            value={phone}
            onChange={(next) => {
              setPhone(next ?? '');
              fe.clearServer('phone');
            }}
            onBlur={fe.controlProps('phone').onBlur}
            inputProps={{ ...fe.controlProps('phone'), ...(phoneKey ? { name: phoneKey } : {}) }}
            required
          />
          <FieldMessage id={fe.errorId('phone')} message={fe.message('phone')} />
        </div>

        {props.showBirthYear && (
          <div>
            <label className="block">
              <span className="bd-label">
                {t('year_of_birth_label')}
                <span className="text-rose-500 ml-0.5">*</span>
              </span>
              <SelectField
                {...fe.controlProps('year_of_birth')}
                name="year_of_birth"
                value={yearOfBirth}
                onChange={chooseYear}
                required
                placeholder={t('year_of_birth_placeholder')}
                options={Array.from({ length: BIRTH_YEAR_CHOICES }, (_, i) => currentYear - i).map(
                  (y) => ({ value: String(y), label: y }),
                )}
              />
            </label>
            <FieldMessage id={fe.errorId('year_of_birth')} message={fe.message('year_of_birth')} />
          </div>
        )}

        {minor ? null : (
          <>
            {props.showTerms && (
              <div>
                <label className="flex items-start gap-2.5 text-[13.5px] text-ink-700 leading-relaxed cursor-pointer">
                  <input
                    type="checkbox"
                    {...fe.controlProps('terms')}
                    name="terms"
                    checked={terms}
                    onChange={(e) => setTerms(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded-sm border-(--bd-border) accent-(--bd-primary-600)"
                  />
                  {termsLabel}
                </label>
                <FieldMessage id={fe.errorId('terms')} message={fe.message('terms')} />
              </div>
            )}

            <div
              data-testid="bot-number"
              className="rounded-[12px] border border-(--bd-border) bg-(--bd-primary-50) px-4 py-3.5"
            >
              <div className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                {t('our_number')}
              </div>
              <div className="mt-1 font-display font-bold text-[20px] text-(--bd-fg)">
                {formatPhoneForReading(props.bot.phone, phoneCountries)}
              </div>
              <p className="mt-1 text-[13px] text-ink-600">
                {t('talk_to_bot', {
                  name: props.bot.display_name,
                  languages: props.bot.languages,
                })}
              </p>
            </div>

            <button
              type="submit"
              disabled={props.busy}
              style={{ backgroundColor: props.brandColor }}
              className="w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-opacity inline-flex items-center justify-center gap-2"
            >
              <I.phone size={16} aria-hidden="true" />
              {props.busy ? t('submitting') : t('submit')}
            </button>
          </>
        )}
      </form>
      {props.consentContent && modalTab ? (
        <ConsentModal
          open
          onOpenChange={(open) => {
            if (!open) setModalTab(null);
          }}
          initialTab={modalTab}
          content={props.consentContent}
        />
      ) : null}
    </>
  );
}
