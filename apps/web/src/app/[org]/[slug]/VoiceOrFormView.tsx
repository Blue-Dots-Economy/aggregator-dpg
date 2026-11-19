'use client';

/**
 * Two-option public registration page (web app, public registration): talk to
 * the voice assistant or register with the form, plus sign-in when the Signals
 * hand-off is configured. The voice path collects name and phone, posts them
 * to `POST /api/:org/:slug/voice-request` and shows the number to call. The
 * form path renders {@link PublicRegistrationView} on its form.
 */

import { useMemo, useRef, useState, type JSX } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';
import { I } from '@/icons';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '@/hooks/useAggregatorConfig';
import {
  registrationShowsConsent,
  domainRequiresBirthYear,
  isMinorBirthYear,
} from '@/lib/registration-gates';
import { LanguageSwitcher } from '@/components/shell/LanguageSwitcher';
import { ConsentGate } from '@/components/consent/ConsentGate';
import { toConsentDocs } from '@/components/consent/consent-docs';
import { readErrorEnvelope, type ErrorEnvelope } from '@/lib/api-error';
import { requestErrorKind } from '@/lib/request-errors';
import { summariseIssues } from '@/lib/response-shape-error';
import { formatPhoneForReading } from '@/lib/phone';
import { languageNames } from '@/lib/language-names';
import { usePhoneCountries } from '@/lib/FormRuntimeConfigProvider';
import type { LinkVoiceBot } from '@/lib/registration-link';
import { MinimalIdentityForm, type MinimalIdentityPayload } from './MinimalIdentityForm';
import { PublicRegistrationView, type PublicRegistrationViewProps } from './PublicRegistrationView';
import { SignalsSignInCta, useSignalsHandoffUrl } from './SignalsSignInCta';

/** Page background used by every state of the public registration page. */
const PAGE_BACKGROUND =
  'radial-gradient(1200px 600px at 50% -10%, var(--bd-tint-primary), transparent 70%), #FBFCFE';

/** Card style shared with the public registration chooser. */
const CARD_CLASS =
  'rounded-[18px] bg-white border border-(--bd-border) px-6 sm:px-8 py-7 shadow-[0_1px_0_rgba(11,16,32,0.02),0_20px_60px_-30px_rgba(11,16,32,0.18)]';

/** Outlined secondary button, as on the public registration page. */
const OUTLINE_BUTTON_CLASS =
  'w-full py-3 rounded-[12px] border border-(--bd-border) bg-white font-display font-bold text-[15px] text-ink-700 hover:bg-ink-50 transition-colors';

/** `POST /api/:org/:slug/voice-request` 200 body. */
const VoiceRequestResponseSchema = z.object({
  existing: z.boolean(),
  voice_bot: z.object({
    display_name: z.string(),
    phone: z.string(),
    languages: z.array(z.string()),
  }),
});

/** The bot the participant is asked to call, with its number. */
type CalledBot = z.infer<typeof VoiceRequestResponseSchema>['voice_bot'];

/** Which screen the page shows. */
type Screen =
  | { kind: 'choose' }
  | { kind: 'voice' }
  | { kind: 'form' }
  | { kind: 'done'; existing: boolean; bot: CalledBot };

/** State of the voice-request submit. */
type VoiceSubmit =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; title: string; detail: string };

/** Props of {@link VoiceOrFormView}: the link's props plus its voice bot. */
export type VoiceOrFormViewProps = PublicRegistrationViewProps & { voiceBot: LinkVoiceBot };

/**
 * Renders the two-option public registration page for a link that offers voice.
 *
 * A 409 `VOICE_BOT_UNAVAILABLE` (the bot was removed after the page loaded)
 * returns to the first screen without the voice option and shows a notice.
 */
export function VoiceOrFormView({ voiceBot, ...props }: VoiceOrFormViewProps): JSX.Element {
  const { org, slug, domain, identity, schema, registrationMode, submissionShape } = props;
  const consentContent = props.consentContent ?? null;
  const t = useTranslations('profile.public_reg');
  const locale = useLocale();
  const tRequest = useTranslations('form.request_error');
  const tRegister = useTranslations('register');
  const phoneCountries = usePhoneCountries();
  const [screen, setScreen] = useState<Screen>({ kind: 'choose' });
  const [voiceUnavailable, setVoiceUnavailable] = useState(false);
  const [submit, setSubmit] = useState<VoiceSubmit>({ status: 'idle' });
  const [serverErrors, setServerErrors] = useState<Record<string, string> | null>(null);
  // Accepted once per participant; a retry does not reopen the gate.
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  // Payload held while the consent gate is open, posted on accept.
  const pendingPayloadRef = useRef<MinimalIdentityPayload | null>(null);

  const { data: cfgData, isError: cfgFailed } = useAggregatorConfig();
  const cfg = cfgData ?? DEFAULT_AGGREGATOR_CONFIG;
  const configResolved = cfgData !== undefined || cfgFailed;
  const signalsHandoffUrl = useSignalsHandoffUrl(domain, registrationMode ?? null, submissionShape);
  const domainCfg = cfg.domains.find((d) => d.id === domain);
  const showConsent = registrationShowsConsent(domainCfg);
  const showBirthYear = domainRequiresBirthYear(domainCfg);
  const brandColor = cfg.brand.primary_color ?? '#4338ca';
  // The voice request creates an account only, so the gate shows terms and privacy.
  const consentDocs = useMemo(
    () =>
      toConsentDocs(
        consentContent
          ? { terms: consentContent.terms, privacy: consentContent.privacy }
          : undefined,
      ),
    [consentContent],
  );
  const agreeLabel = `${t('consent_accept_prefix')}${t('consent_docs_link')}.`;
  // The bot identifies the caller by phone, so email is not collected.
  const voiceIdentity = { name: identity?.name, phone: identity?.phone };

  /**
   * Moves to the result screen, or shows an error when the body is not the expected shape.
   *
   * @param body - The parsed 200 body.
   * @param path - The request path, for the log line.
   */
  const handleVoiceSuccess = (body: unknown, path: string): void => {
    const parsed = VoiceRequestResponseSchema.safeParse(body);
    if (!parsed.success) {
      console.error('[public-registration] unexpected response shape', {
        url: path,
        issues: body === null ? [] : summariseIssues(parsed.error.issues),
      });
      setSubmit({
        status: 'error',
        title: t('error_submission_title'),
        detail: tRequest('generic'),
      });
      return;
    }
    setSubmit({ status: 'idle' });
    setScreen({ kind: 'done', existing: parsed.data.existing, bot: parsed.data.voice_bot });
  };

  /**
   * Handles a rejected voice request: back to the first screen when the bot is
   * gone, a field error for a bad phone, else the error banner.
   *
   * @param status - HTTP status.
   * @param body - The parsed error body, or null.
   */
  const handleVoiceRejection = (status: number, body: unknown): void => {
    const error = readErrorEnvelope(body);
    if (status === 409 && error.code === 'VOICE_BOT_UNAVAILABLE') {
      setVoiceUnavailable(true);
      setSubmit({ status: 'idle' });
      setScreen({ kind: 'choose' });
      return;
    }
    if (error.code === 'INVALID_PHONE' && identity?.phone) {
      setServerErrors({ [identity.phone]: t('error_phone_invalid') });
      setSubmit({ status: 'idle' });
      return;
    }
    setSubmit({
      status: 'error',
      title: t('error_submission_title'),
      detail: errorText(status, error),
    });
  };

  /**
   * Shows the error banner for a request that failed before a response arrived.
   *
   * @param err - What `fetch` or the handling threw.
   */
  const handleVoiceFailure = (err: unknown): void => {
    // `fetch` rejects with a TypeError when the request never reached the server.
    const network = err instanceof TypeError;
    if (!network) {
      console.error('[public-registration] voice request handling failed', {
        error_type: err instanceof Error ? err.name : typeof err,
      });
    }
    setSubmit({
      status: 'error',
      title: t('error_submission_title'),
      detail: tRequest(network ? 'network' : 'generic'),
    });
  };

  /**
   * Posts the voice request and moves to the result, the first screen (bot
   * gone) or an error.
   *
   * @param payload - Name, phone and, where collected, birth year.
   * @param consentGiven - Value for `consent_terms` / `consent_privacy`.
   */
  const postVoiceRequest = async (
    payload: MinimalIdentityPayload,
    consentGiven: boolean,
  ): Promise<void> => {
    setSubmit({ status: 'submitting' });
    const path = `/api/${encodeURIComponent(org)}/${encodeURIComponent(slug)}/voice-request`;
    const consent = showConsent
      ? { consent_terms: consentGiven, consent_privacy: consentGiven }
      : {};
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ...consent }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (res.ok) handleVoiceSuccess(body, path);
      else handleVoiceRejection(res.status, body);
    } catch (err) {
      handleVoiceFailure(err);
    }
  };

  /**
   * One readable sentence for a rejected voice request.
   *
   * @param status - HTTP status.
   * @param error - The API's error envelope.
   * @returns The message for the banner.
   */
  const errorText = (status: number, error: ErrorEnvelope): string => {
    if (error.code === 'LINK_NOT_LIVE') return t('error_link_not_live');
    if (error.code === 'U18_REGISTRATION_REDIRECT') return t('error_u18');
    if (error.code === 'CONSENT_REQUIRED') return t('error_consent_required');
    return tRequest(requestErrorKind(status));
  };

  /** Opens the consent gate when needed, else posts the request. */
  const handleVoiceSubmit = async (payload: MinimalIdentityPayload): Promise<void> => {
    setServerErrors(null);
    const minor = showBirthYear && isMinorBirthYear(payload['year_of_birth']);
    if (showConsent && !minor && !consentAccepted) {
      if (consentDocs.length === 0) {
        setSubmit({
          status: 'error',
          title: tRegister('consent.load_failed_title'),
          detail: tRegister('consent.load_failed_detail'),
        });
        return;
      }
      pendingPayloadRef.current = payload;
      setGateOpen(true);
      return;
    }
    await postVoiceRequest(payload, consentAccepted);
  };

  /** Accepting the gate: records consent, closes it, and posts the held payload. */
  const handleGateAccept = (): void => {
    const payload = pendingPayloadRef.current;
    if (!payload) return;
    setGateOpen(false);
    setConsentAccepted(true);
    void postVoiceRequest(payload, true);
  };

  /**
   * Back to the first screen with nothing carried over, so the next person on
   * a shared phone sees the consent gate and no earlier error.
   */
  const startOver = (): void => {
    setScreen({ kind: 'choose' });
    setSubmit({ status: 'idle' });
    setServerErrors(null);
    setConsentAccepted(false);
    pendingPayloadRef.current = null;
  };

  if (screen.kind === 'form') {
    return (
      <PublicRegistrationView
        {...props}
        startWithForm
        onBack={() => setScreen({ kind: 'choose' })}
      />
    );
  }

  const offerVoice = !voiceUnavailable;
  const languages = languageNames(voiceBot.languages, locale);

  let content: JSX.Element;
  if (!configResolved) {
    content = (
      <div
        data-testid="public-reg-loading"
        className="h-[300px] rounded-[18px] border border-(--bd-border) bg-white animate-pulse"
      />
    );
  } else if (screen.kind === 'voice') {
    content = (
      <>
        <button
          type="button"
          onClick={startOver}
          className="mb-4 inline-flex items-center gap-1 text-[13px] font-semibold text-ink-500 hover:text-ink-700"
        >
          <I.arrowL size={14} />
          {t('chooser_back')}
        </button>
        {submit.status === 'error' ? (
          <div
            role="alert"
            className="mb-5 rounded-[10px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700"
          >
            <div className="font-semibold">{submit.title}</div>
            <div className="mt-1 text-rose-600">{submit.detail}</div>
          </div>
        ) : null}
        <MinimalIdentityForm
          identity={voiceIdentity}
          phonePattern={phonePatternOf(schema, identity?.phone)}
          onSubmit={handleVoiceSubmit}
          brandColor={brandColor}
          requirePhone
          showConsent={showConsent}
          showBirthYear={showBirthYear}
          serverErrors={serverErrors}
          busy={submit.status === 'submitting'}
          title={t('voice_form_title')}
          helper={t('voice_form_subtitle')}
          submitLabel={t('voice_continue')}
        />
      </>
    );
  } else if (screen.kind === 'done') {
    content = (
      <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 p-6">
        <div className="flex items-center gap-2.5 font-display font-bold text-[18px] text-emerald-800">
          <span className="w-7 h-7 rounded-full bg-emerald-500 text-white inline-flex items-center justify-center">
            <I.check size={16} stroke={2.6} />
          </span>
          {screen.existing ? t('voice_done_existing_title') : t('voice_done_new_title')}
        </div>
        <p className="text-[14px] text-emerald-700 mt-3 leading-relaxed">
          {t('voice_done_body', {
            name: screen.bot.display_name,
            languages: languageNames(screen.bot.languages, locale),
          })}
        </p>
        <a
          href={`tel:${screen.bot.phone}`}
          style={{ backgroundColor: brandColor }}
          className="mt-5 w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white hover:opacity-90 transition-opacity inline-flex items-center justify-center gap-2"
        >
          <I.phone size={16} aria-hidden="true" />
          {t('voice_call_cta', { phone: formatPhoneForReading(screen.bot.phone, phoneCountries) })}
        </a>
        <button type="button" onClick={startOver} className={`mt-3 ${OUTLINE_BUTTON_CLASS}`}>
          {t('btn_register_another')}
        </button>
      </div>
    );
  } else {
    content = (
      <div className={CARD_CLASS} data-testid="voice-chooser">
        <h2 className="font-display font-bold text-[19px] text-(--bd-fg) tracking-tight">
          {t('voice_chooser_title')}
        </h2>
        <p className="mt-2 text-[14px] text-ink-500 leading-relaxed">
          {t('voice_chooser_subtitle')}
        </p>
        {voiceUnavailable ? (
          <output className="mt-4 block rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
            {t('voice_unavailable')}
          </output>
        ) : null}
        <div className="mt-5 flex flex-col gap-3">
          {offerVoice ? (
            <button
              type="button"
              onClick={() => setScreen({ kind: 'voice' })}
              style={{ backgroundColor: brandColor }}
              className="w-full py-3 px-4 rounded-[12px] text-white hover:opacity-90 transition-opacity bd-shadow-lg flex flex-col items-center"
            >
              <span className="inline-flex items-center gap-2 font-display font-bold text-[15px]">
                <I.phone size={16} aria-hidden="true" />
                {t('voice_cta')}
              </span>
              <span className="mt-0.5 text-[12.5px] text-white/85">
                {voiceBot.display_name} · {languages}
              </span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setScreen({ kind: 'form' })}
            className={OUTLINE_BUTTON_CLASS}
          >
            {t('voice_form_cta')}
          </button>
          {signalsHandoffUrl ? <SignalsSignInCta href={signalsHandoffUrl} /> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="bd-public-light min-h-screen w-full" style={{ background: PAGE_BACKGROUND }}>
      <div className="max-w-[640px] mx-auto px-4 sm:px-6 lg:px-10 py-8 sm:py-12">
        <div className="flex justify-end mb-3">
          <LanguageSwitcher />
        </div>
        {content}
      </div>
      <ConsentGate
        open={gateOpen}
        docs={consentDocs}
        agreeLabel={agreeLabel}
        onAccept={handleGateAccept}
        onCancel={() => setGateOpen(false)}
      />
    </div>
  );
}

/** Schema `properties` read loosely, to find one field's `pattern`. */
const PatternedSchemaSchema = z.object({
  properties: z.record(z.string(), z.object({ pattern: z.string().optional() }).loose()),
});

/**
 * The identity phone field's `pattern`, so the phone box stores what the schema accepts.
 *
 * @param schema - The link's JSON Schema.
 * @param key - The identity phone key.
 * @returns The pattern, or undefined when the schema has none.
 */
function phonePatternOf(schema: unknown, key: string | undefined): string | undefined {
  if (!key) return undefined;
  const parsed = PatternedSchemaSchema.safeParse(schema);
  if (!parsed.success) return undefined;
  return Object.hasOwn(parsed.data.properties, key)
    ? parsed.data.properties[key]?.pattern
    : undefined;
}
