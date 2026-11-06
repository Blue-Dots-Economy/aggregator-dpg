'use client';

import { useMemo, useState, type JSX } from 'react';
import type { ErrorSchema, RJSFSchema } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { readableFormErrors } from '@/lib/readable-form-errors';
import { LanguageSwitcher } from '@/components/shell/LanguageSwitcher';
import { ConsentGate } from '@/components/consent/ConsentGate';
import { toConsentDocs } from '@/components/consent/consent-docs';
import type { ParticipantConsent } from '@/components/consent/consent-types';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '@/hooks/useAggregatorConfig';
import { registrationShowsConsent, domainRequiresBirthYear } from '@/lib/registration-gates';
import type { LinkIdentity } from '@/lib/registration-link';
import { MinimalIdentityForm, type MinimalIdentityPayload } from './MinimalIdentityForm';
import { useSignalsHandoffUrl } from './SignalsSignInCta';
import { BackToChooserButton, RegistrationChooser } from './_components/RegistrationChooser';
import { OwnedElsewhereBanner } from './_components/OwnedElsewhereBanner';
import { ProfileForm } from './_components/ProfileForm';
import { PublicPageShell } from './_components/PublicPageShell';
import { RegistrationDonePanel } from './_components/RegistrationDonePanel';
import { RegistrationHeader } from './_components/RegistrationHeader';
import { RegistrationHero } from './_components/RegistrationHero';
import { SubmitErrorBanner } from './_components/SubmitErrorBanner';
import { readBirthYear } from './_lib/birth-year';
import { readLinkEventDetails } from './_lib/link-context';
import { useRegistrationSubmit, type ItemLocation } from './_lib/use-registration-submit';
import { useSignalsHandoff } from './_lib/use-signals-handoff';

/** Readable RJSF errors; kept exported here for existing callers. */
export { readableFormErrors };

/** Hero fill when the brand has no primary colour. */
const DEFAULT_HERO_COLOR = '#4338ca';

/** Card style shared by the chooser card and the form card. */
const CARD_CLASS =
  'rounded-[18px] bg-white border border-(--bd-border) shadow-[0_1px_0_rgba(11,16,32,0.02),0_20px_60px_-30px_rgba(11,16,32,0.18)]';

/** Keys cleared from the form when the participant picks a different contact. */
const FALLBACK_CONTACT_KEYS = ['email', 'phone', 'phone_number', 'mobile'] as const;

export interface PublicRegistrationViewProps {
  org: string;
  slug: string;
  /**
   * Signalstack network id (e.g. 'blue_dot'), used by the pre-submit identity
   * probe. An empty string disables the probe.
   */
  network?: string;
  domain: string;
  context: Record<string, unknown>;
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
  /**
   * Identity field names for the domain (name / phone / email). The
   * account_only form collects only these fields.
   */
  identity?: LinkIdentity | undefined;
  /**
   * Link submission shape. `account_only` renders identity fields only;
   * `account_and_profile` renders the full profile form.
   */
  submissionShape: 'account_only' | 'account_and_profile';
  /** Optional i18n key for a hint below the form. `null` means no hint. */
  publicHintI18nKey: string | null;
  /**
   * Registration mode key (e.g. `voice`, `form`). Voice links make the phone
   * number required on the minimal form.
   */
  registrationMode?: string | null;
  /**
   * Participant consent content: Terms, Privacy, and the profile-creation
   * statement. `null` when unavailable.
   */
  consentContent?: ParticipantConsent | null;
}

/**
 * Renders the anonymous participant registration form.
 *
 * Submit POSTs to the BFF, which proxies to `/public/v1/registrations/create/:slug`.
 */
export function PublicRegistrationView({
  org,
  slug,
  network = '',
  domain,
  context,
  schema,
  uiSchema,
  identity,
  submissionShape,
  publicHintI18nKey,
  registrationMode,
  consentContent = null,
}: PublicRegistrationViewProps): JSX.Element {
  const t = useTranslations('profile.public_reg');
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  /**
   * Whether the user chose "Register" on the chooser. Kept as view state, not
   * a route change, because printed QR codes encode `/<org>/<slug>` exactly.
   * Not used when the Signals hand-off is not configured.
   */
  const [formRevealed, setFormRevealed] = useState(false);
  // Show required-field errors only after the user tries to submit.
  const [showValidation, setShowValidation] = useState(false);
  // Field errors the server returned for the last submit, shown inline;
  // cleared as soon as the participant edits the form.
  const [serverFieldErrors, setServerFieldErrors] = useState<ErrorSchema | undefined>(undefined);
  // Coordinates the registrant picked from the address autocomplete, sent as
  // `item_locations` so Signals stores that point. Empty when nothing was
  // picked; Signals then geocodes the address text.
  const [resolvedLocations, setResolvedLocations] = useState<ItemLocation[]>([]);
  // Year of birth from the full-profile form. A minor submits without consent
  // and accepts terms later in the Signalstack app.
  const [yearOfBirth, setYearOfBirth] = useState('');
  const birthYear = readBirthYear(yearOfBirth, new Date().getFullYear());

  const { data: cfgData, isError: cfgFailed } = useAggregatorConfig();
  const cfg = cfgData ?? DEFAULT_AGGREGATOR_CONFIG;
  /**
   * Whether the config query has finished, with data or with an error. Used to
   * pick chooser or form without a flash. On error the form renders without
   * the chooser so participants can still register.
   */
  const configResolved = cfgData !== undefined || cfgFailed;
  // Signals sign-in URL for existing participants; `null` when the hand-off is
  // not configured for this domain and mode.
  const signalsHandoffUrl = useSignalsHandoffUrl(domain, registrationMode ?? null, submissionShape);
  const handoff = useSignalsHandoff(signalsHandoffUrl);
  // The consent step and birth-year field are set per domain in network.json.
  const domainCfg = cfg.domains.find((d) => d.id === domain);
  const showBirthYear = domainRequiresBirthYear(domainCfg);
  const showConsent = registrationShowsConsent(domainCfg);
  // `account_only` renders MinimalIdentityForm instead of the RJSF form. Its
  // submit goes through the same consent gate with terms and privacy only.
  const isAccountOnly = submissionShape === 'account_only';
  // Consent documents for the gate. Empty when content is missing; submit
  // then shows an error instead of opening the gate. Account-only creates no
  // profile, so its gate shows terms and privacy only; the API rejects
  // `consent_profile` for this shape.
  const consentDocs = useMemo(
    () =>
      toConsentDocs(
        consentContent && isAccountOnly
          ? { terms: consentContent.terms, privacy: consentContent.privacy }
          : (consentContent ?? undefined),
      ),
    [consentContent, isAccountOnly],
  );
  // One sentence covering terms, privacy, and (full profile only) profile creation.
  const agreeLabel = isAccountOnly
    ? `${t('consent_accept_prefix')}${t('consent_docs_link')}.`
    : `${t('consent_accept_prefix')}${t('consent_docs_link')}${t('consent_profile_conjunction')}`;

  const registration = useRegistrationSubmit({
    org,
    slug,
    network,
    domain,
    identity,
    showConsent,
    showBirthYear,
    isAccountOnly,
    consentDocs,
    yearOfBirth,
    resolvedLocations,
    onFieldErrors: (errors) => {
      setServerFieldErrors(errors);
      setShowValidation(true);
    },
    // Start the hand-off after a successful submit (`passed` or `skipped`)
    // when it is configured.
    onDone: handoff.start,
  });
  const { state, lookup } = registration;

  const handleMinimalSubmit = (payload: MinimalIdentityPayload): Promise<void> =>
    registration.submit({ ...payload });

  const handleRegisterAnother = (): void => {
    setFormData({});
    setShowValidation(false);
    setYearOfBirth('');
    registration.reset();
    // Cancel the hand-off so back-to-back registrations stay on this page.
    handoff.cancel();
  };

  const handleUseDifferentContact = (): void => {
    registration.dismissLookup();
    // Clear the identity fields so the user can retry. Other field values stay.
    setFormData((prev) => {
      const next = { ...prev };
      for (const key of [identity?.email, identity?.phone, ...FALLBACK_CONTACT_KEYS]) {
        if (key) delete next[key];
      }
      return next;
    });
  };

  // Consent gate rendered by both the account-only and full-profile branches.
  const consentGateElement = (
    <ConsentGate
      open={registration.gate.open}
      docs={consentDocs}
      agreeLabel={agreeLabel}
      onAccept={registration.gate.accept}
      onCancel={registration.gate.cancel}
    />
  );

  const heroColor = cfg.brand.primary_color ?? DEFAULT_HERO_COLOR;

  // Show a placeholder until the config query finishes, so the chooser or
  // form does not flash. A failed query also finishes, with no hand-off.
  if (!configResolved) {
    return (
      <PublicPageShell busy>
        <div
          className={`${isAccountOnly ? 'max-w-[640px]' : 'max-w-[760px]'} mx-auto px-4 sm:px-6 lg:px-10 py-8 sm:py-12`}
        >
          <div
            data-testid="public-reg-loading"
            className="h-[300px] rounded-[18px] border border-(--bd-border) bg-white animate-pulse"
          />
        </div>
      </PublicPageShell>
    );
  }

  // Chooser between Register and Sign in, shown first when the Signals
  // hand-off is configured. Without a hand-off URL the form renders directly.
  const showChooser = signalsHandoffUrl !== null && !formRevealed;
  const chooserPanel = signalsHandoffUrl ? (
    <RegistrationChooser
      signalsUrl={signalsHandoffUrl}
      brandColor={cfg.brand.primary_color}
      onRegister={() => setFormRevealed(true)}
    />
  ) : null;
  // Lets the user go back from the form to the chooser.
  const backToChooser =
    signalsHandoffUrl && formRevealed ? (
      <BackToChooserButton onBack={() => setFormRevealed(false)} />
    ) : null;

  // Render the account-only form while `idle` or `submitting`, so it stays
  // mounted and keeps its local field state during submit. `done` and
  // `error` fall through to the shared views below.
  if (isAccountOnly && (state.status === 'idle' || state.status === 'submitting') && !lookup) {
    return (
      <PublicPageShell>
        <div className="max-w-[640px] mx-auto px-4 sm:px-6 lg:px-10 py-8 sm:py-12">
          <div className="flex justify-end mb-3">
            <LanguageSwitcher />
          </div>
          {showChooser ? (
            <div className={`${CARD_CLASS} px-6 sm:px-8 py-7`}>{chooserPanel}</div>
          ) : (
            <>
              {backToChooser}
              {/* `busy` is the form's only in-flight flag. */}
              <MinimalIdentityForm
                identity={identity ?? {}}
                onSubmit={handleMinimalSubmit}
                brandColor={heroColor}
                hintI18nKey={publicHintI18nKey}
                requirePhone={registrationMode === 'voice'}
                showConsent={showConsent}
                showBirthYear={showBirthYear}
                busy={state.status === 'submitting'}
              />
            </>
          )}
        </div>
        {consentGateElement}
      </PublicPageShell>
    );
  }

  return (
    <PublicPageShell>
      <div className="max-w-[760px] mx-auto px-4 sm:px-6 lg:px-10 py-8 sm:py-12">
        <RegistrationHeader brandShort={cfg.brand.short_name} brandLogo={cfg.brand.logo?.default} />

        <div className={`${CARD_CLASS} overflow-hidden`}>
          <RegistrationHero
            color={heroColor}
            domainLabel={domainCfg?.label ?? domainCfg?.plural_label ?? domain}
            details={readLinkEventDetails(context)}
          />

          <div className="px-6 sm:px-8 py-7">
            {state.status === 'done' ? (
              <RegistrationDonePanel
                outcome={state.outcome}
                submissionId={state.submissionId}
                handoff={handoff.handoff}
                brandColor={cfg.brand.primary_color}
                onContinue={handoff.continueNow}
                onRegisterAnother={handleRegisterAnother}
              />
            ) : showChooser ? (
              chooserPanel
            ) : (
              <>
                {backToChooser}
                {state.status === 'error' ? <SubmitErrorBanner error={state} /> : null}
                {lookup?.kind === 'owned_elsewhere' ? (
                  <OwnedElsewhereBanner onUseDifferentContact={handleUseDifferentContact} />
                ) : null}
                {/* Account-only links show only the banners here, never the RJSF form. */}
                {!isAccountOnly && (
                  <ProfileForm
                    schema={schema}
                    uiSchema={uiSchema}
                    identity={identity}
                    formData={formData}
                    onFormDataChange={(data) => {
                      setFormData(data);
                      if (serverFieldErrors) setServerFieldErrors(undefined);
                    }}
                    serverFieldErrors={serverFieldErrors}
                    showValidation={showValidation}
                    onValidationFailed={(messages) => {
                      setShowValidation(true);
                      registration.fail({
                        title: t('validation_error_title'),
                        detail: messages.join(' ') || t('validation_required'),
                        code: 'VALIDATION',
                      });
                    }}
                    onSubmit={(values) => void registration.submit(values)}
                    onLocationsResolved={setResolvedLocations}
                    showBirthYear={showBirthYear}
                    yearOfBirth={yearOfBirth}
                    onYearOfBirthChange={setYearOfBirth}
                    yearOfBirthValid={birthYear.valid}
                    showMinorNotice={showConsent && birthYear.isMinor}
                    submitting={state.status === 'submitting'}
                    brandColor={cfg.brand.primary_color}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {consentGateElement}
    </PublicPageShell>
  );
}
