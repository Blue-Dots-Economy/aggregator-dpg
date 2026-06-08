/**
 * Identity-only registration form rendered when a public link has
 * `submission_mode === 'account_only'`. Collects name + phone or email +
 * consent and nothing else. The parent view (`PublicRegistrationView`)
 * passes the network's identity field names (e.g. `phone` vs
 * `mobile_number`) so the body posted to the API uses the right keys
 * for the link's domain. No RJSF, no profile schema, no `partial`
 * checkbox — the link itself locks the capture scope.
 */
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

export interface MinimalIdentityPayload {
  /** Name field. Key is the network's `identity.name` selector. */
  [name: string]: string | boolean;
}

export interface MinimalIdentityFormProps {
  /**
   * Identity field selectors from the network config — the wire keys the
   * submitted body must use. `phone` / `email` may be undefined when the
   * domain doesn't declare them; the corresponding input is hidden.
   */
  identity: {
    name?: string;
    phone?: string;
    email?: string;
  };
  /** Submit handler — receives the identity-only payload. */
  onSubmit: (payload: MinimalIdentityPayload) => void | Promise<void>;
  /** Disables the submit button while the parent is in flight. */
  busy?: boolean;
}

export function MinimalIdentityForm(props: MinimalIdentityFormProps): JSX.Element {
  const t = useTranslations('profile.public_reg.account_only');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [consentTerms, setConsentTerms] = useState(false);
  const [consentPrivacy, setConsentPrivacy] = useState(false);

  const nameKey = props.identity.name;
  const phoneKey = props.identity.phone;
  const emailKey = props.identity.email;

  // Identity invariant per the design: name AND (phone OR email).
  const hasName = name.trim().length > 0;
  const hasPhone = !!phoneKey && phone.trim().length > 0;
  const hasEmail = !!emailKey && email.trim().length > 0;
  const valid = hasName && (hasPhone || hasEmail) && consentTerms && consentPrivacy;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || !nameKey) return;
        const payload: MinimalIdentityPayload = {
          [nameKey]: name.trim(),
          consent_terms: true,
          consent_privacy: true,
        };
        if (phoneKey && hasPhone) payload[phoneKey] = phone.trim();
        if (emailKey && hasEmail) payload[emailKey] = email.trim();
        void props.onSubmit(payload);
      }}
      noValidate
    >
      <h2>{t('title')}</h2>
      <p>{t('helper')}</p>

      <label>
        {t('name_label')}
        <input
          type="text"
          name={nameKey ?? 'name'}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoComplete="name"
        />
      </label>

      {(phoneKey || emailKey) && (
        <fieldset>
          <legend>{t('contact_label')}</legend>
          {phoneKey && (
            <label>
              {t('phone_label')}
              <input
                type="tel"
                name={phoneKey}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
              />
            </label>
          )}
          {emailKey && (
            <label>
              {t('email_label')}
              <input
                type="email"
                name={emailKey}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </label>
          )}
        </fieldset>
      )}

      <label>
        <input
          type="checkbox"
          name="consent_terms"
          checked={consentTerms}
          onChange={(e) => setConsentTerms(e.target.checked)}
        />
        {t('consent_terms_label')}
      </label>

      <label>
        <input
          type="checkbox"
          name="consent_privacy"
          checked={consentPrivacy}
          onChange={(e) => setConsentPrivacy(e.target.checked)}
        />
        {t('consent_privacy_label')}
      </label>

      <button type="submit" disabled={!valid || props.busy}>
        {t('submit_label')}
      </button>
    </form>
  );
}
