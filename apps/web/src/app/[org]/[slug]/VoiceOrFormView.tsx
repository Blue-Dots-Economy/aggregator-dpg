'use client';

/**
 * Two-option public registration page (web app, public registration). The
 * first screen is "Call to register": the domain's minimum identity fields,
 * the terms checkbox and the voice bot's number, posted to
 * `POST /api/:org/:slug/voice-request` before the phone's dialler opens.
 * Below it, "Fill a form to register" opens {@link PublicRegistrationView} on
 * its form, and a sign-in line links to Signals when the hand-off is on.
 */

import { useEffect, useState, type JSX } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';
import { I } from '@/icons';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '@/hooks/useAggregatorConfig';
import { registrationShowsConsent, domainRequiresBirthYear } from '@/lib/registration-gates';
import { readErrorEnvelope, type ErrorEnvelope } from '@/lib/api-error';
import { requestErrorKind } from '@/lib/request-errors';
import { summariseIssues } from '@/lib/response-shape-error';
import { formatPhoneForReading } from '@/lib/phone';
import { languageNames } from '@/lib/language-names';
import { usePhoneCountries } from '@/lib/FormRuntimeConfigProvider';
import type { LinkVoiceBot } from '@/lib/registration-link';
import { CallToRegisterForm, type CallPayload } from './CallToRegisterForm';
import { MinorRedirectNotice } from './MinorRedirectNotice';
import { PublicRegistrationView, type PublicRegistrationViewProps } from './PublicRegistrationView';
import { FALLBACK_BRAND_COLOR, RegistrationShell } from './RegistrationShell';
import {
  SignalsSignInLine,
  navigateToSignals,
  useSignalsHandoffUrl,
  useSignalsUiUrl,
} from './SignalsSignInCta';

/** Outlined secondary button, as on the public registration page. */
const OUTLINE_BUTTON_CLASS =
  'w-full py-3 rounded-[12px] border border-(--bd-border) bg-white font-display font-bold text-[15px] text-ink-700 hover:bg-ink-50 transition-colors';

/** Media query true on phones and tablets, where a `tel:` address opens the dialler. */
const TOUCH_DEVICE_QUERY = '(pointer: coarse)';

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
  { kind: 'call' } | { kind: 'form' } | { kind: 'called'; existing: boolean; bot: CalledBot };

/** State of the voice-request submit. */
type VoiceSubmit =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; title: string; detail: string };

/** Props of {@link VoiceOrFormView}: the link's props plus its voice bot. */
export type VoiceOrFormViewProps = PublicRegistrationViewProps & { voiceBot: LinkVoiceBot };

/**
 * Opens the phone's dialler with the bot's number, on touch devices only.
 *
 * A computer has no dialler; there the page shows the number and a call link.
 *
 * @param phone - The bot's number.
 */
function openDialler(phone: string): void {
  if (typeof window.matchMedia !== 'function' || !window.matchMedia(TOUCH_DEVICE_QUERY).matches) {
    return;
  }
  try {
    window.location.assign(`tel:${phone}`);
  } catch (err) {
    console.error('[public-registration] the dialler did not open; the call button stays', {
      operation: 'voice-request.dial',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Sends the participant to Signals when they come back to the page after the call.
 *
 * The dialler hides the page; the first time it is visible again, the page
 * moves to `url`. Does nothing while `url` is null.
 *
 * @param url - The Signals page, or null.
 */
function useSignalsAfterCall(url: string | null): void {
  useEffect(() => {
    if (!url) return;
    let wentAway = false;
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        wentAway = true;
      } else if (wentAway) {
        navigateToSignals(url);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [url]);
}

/**
 * Renders the two-option public registration page for a link that offers voice.
 *
 * A 409 `VOICE_BOT_UNAVAILABLE` (the bot was removed after the page loaded)
 * hides the call form and shows a notice; the form path stays.
 */
export function VoiceOrFormView({ voiceBot, ...props }: VoiceOrFormViewProps): JSX.Element {
  const { org, slug, domain, context, identity, schema, registrationMode, submissionShape } = props;
  const consentContent = props.consentContent ?? null;
  const t = useTranslations('profile.public_reg');
  const locale = useLocale();
  const tRequest = useTranslations('form.request_error');
  const phoneCountries = usePhoneCountries();
  const [screen, setScreen] = useState<Screen>({ kind: 'call' });
  const [voiceUnavailable, setVoiceUnavailable] = useState(false);
  const [submit, setSubmit] = useState<VoiceSubmit>({ status: 'idle' });
  const [serverErrors, setServerErrors] = useState<Record<string, string> | null>(null);
  const [minor, setMinor] = useState(false);
  // Remounts the call form with empty fields for the next person.
  const [formKey, setFormKey] = useState(0);

  const { data: cfgData, isError: cfgFailed } = useAggregatorConfig();
  const cfg = cfgData ?? DEFAULT_AGGREGATOR_CONFIG;
  const configResolved = cfgData !== undefined || cfgFailed;
  const signInUrl = useSignalsHandoffUrl(domain, registrationMode ?? null, submissionShape);
  const signalsUrl = useSignalsUiUrl(domain);
  const domainCfg = cfg.domains.find((d) => d.id === domain);
  const showConsent = registrationShowsConsent(domainCfg);
  const showBirthYear = domainRequiresBirthYear(domainCfg);
  const brandColor = cfg.brand.primary_color ?? FALLBACK_BRAND_COLOR;
  const fields = identityFieldsOf(schema, identity?.name, identity?.phone);

  useSignalsAfterCall(screen.kind === 'called' ? signalsUrl : null);

  /**
   * Moves to the call screen and opens the dialler, or shows an error when the
   * body is not the expected shape.
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
    setScreen({ kind: 'called', existing: parsed.data.existing, bot: parsed.data.voice_bot });
    openDialler(parsed.data.voice_bot.phone);
  };

  /**
   * Handles a rejected voice request: the notice when the bot is gone, a field
   * error for a bad phone, else the error banner.
   *
   * @param status - HTTP status.
   * @param body - The parsed error body, or null.
   */
  const handleVoiceRejection = (status: number, body: unknown): void => {
    const error = readErrorEnvelope(body);
    if (status === 409 && error.code === 'VOICE_BOT_UNAVAILABLE') {
      setVoiceUnavailable(true);
      setSubmit({ status: 'idle' });
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
   * Posts the voice request. The terms box is ticked by then, so consent is
   * sent as given wherever the domain asks for it.
   *
   * @param payload - Name, phone and, where collected, birth year.
   */
  const postVoiceRequest = async (payload: CallPayload): Promise<void> => {
    setServerErrors(null);
    setSubmit({ status: 'submitting' });
    const path = `/api/${encodeURIComponent(org)}/${encodeURIComponent(slug)}/voice-request`;
    const consent = showConsent ? { consent_terms: true, consent_privacy: true } : {};
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

  /** Back to the first screen with empty fields, for the next person on a shared phone. */
  const startOver = (): void => {
    setScreen({ kind: 'call' });
    setSubmit({ status: 'idle' });
    setServerErrors(null);
    setMinor(false);
    setFormKey((k) => k + 1);
  };

  if (screen.kind === 'form') {
    return (
      <PublicRegistrationView {...props} startWithForm onBack={() => setScreen({ kind: 'call' })} />
    );
  }

  let content: JSX.Element;
  if (!configResolved) {
    content = (
      <div
        data-testid="public-reg-loading"
        className="h-[300px] rounded-[14px] bg-ink-50 animate-pulse"
      />
    );
  } else if (screen.kind === 'called') {
    content = (
      <CalledPanel
        existing={screen.existing}
        botName={screen.bot.display_name}
        phone={screen.bot.phone}
        phoneLabel={formatPhoneForReading(screen.bot.phone, phoneCountries)}
        brandColor={brandColor}
        signalsUrl={signalsUrl}
        onRegisterAnother={startOver}
      />
    );
  } else {
    content = (
      <div className="flex flex-col gap-5" data-testid="voice-call-screen">
        {voiceUnavailable ? (
          <output className="block rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
            {t('voice_unavailable')}
          </output>
        ) : null}
        {submit.status === 'error' ? (
          <div
            role="alert"
            className="rounded-[10px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700"
          >
            <div className="font-semibold">{submit.title}</div>
            <div className="mt-1 text-rose-600">{submit.detail}</div>
          </div>
        ) : null}
        {voiceUnavailable ? null : (
          <CallToRegisterForm
            key={formKey}
            identity={identity ?? {}}
            labels={fields.labels}
            phonePattern={fields.phonePattern}
            showBirthYear={showBirthYear}
            showTerms={showConsent}
            consentContent={consentContent}
            bot={{
              display_name: voiceBot.display_name,
              phone: voiceBot.phone,
              languages: languageNames(voiceBot.languages, locale),
              description: voiceBot.description,
            }}
            onSubmit={(payload) => void postVoiceRequest(payload)}
            onMinorChange={setMinor}
            busy={submit.status === 'submitting'}
            serverErrors={serverErrors}
            brandColor={brandColor}
          />
        )}
        {voiceUnavailable ? null : (
          <div className="flex items-center gap-3 text-[12.5px] text-ink-400" aria-hidden="true">
            <span className="h-px flex-1 bg-(--bd-border)" />
            {t('call.or')}
            <span className="h-px flex-1 bg-(--bd-border)" />
          </div>
        )}
        <button
          type="button"
          onClick={() => setScreen({ kind: 'form' })}
          className={`${OUTLINE_BUTTON_CLASS} flex flex-col items-center`}
        >
          <span>{t('call.form_cta')}</span>
          <span className="mt-0.5 text-[12.5px] font-normal font-sans text-ink-500">
            {t('call.form_cta_hint')}
          </span>
        </button>
        {signInUrl ? <SignalsSignInLine href={signInUrl} /> : null}
      </div>
    );
  }

  return (
    <RegistrationShell domain={domain} context={context}>
      {content}
      {minor && screen.kind === 'call' ? (
        <MinorRedirectNotice url={signalsUrl} navigate={navigateToSignals} />
      ) : null}
    </RegistrationShell>
  );
}

/** Props of {@link CalledPanel}. */
interface CalledPanelProps {
  /** The phone already had a Signals account. */
  existing: boolean;
  botName: string;
  /** The bot's number, for the `tel:` link. */
  phone: string;
  /** The bot's number as read aloud. */
  phoneLabel: string;
  brandColor: string;
  /** Where "Continue to BlueDots" goes; the button is hidden when null. */
  signalsUrl: string | null;
  onRegisterAnother: () => void;
}

/**
 * Screen after a saved request: the call button, the way on to Signals and
 * "Register another".
 *
 * @param props - The bot, the Signals URL and the restart callback.
 * @returns The panel.
 */
function CalledPanel(props: Readonly<CalledPanelProps>): JSX.Element {
  const t = useTranslations('profile.public_reg');
  return (
    <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 p-6">
      <div className="flex items-center gap-2.5 font-display font-bold text-[18px] text-emerald-800">
        <span className="w-7 h-7 rounded-full bg-emerald-500 text-white inline-flex items-center justify-center">
          <I.check size={16} stroke={2.6} />
        </span>
        {props.existing ? t('voice_done_existing_title') : t('voice_done_new_title')}
      </div>
      <p className="text-[14px] text-emerald-700 mt-3 leading-relaxed">
        {t(props.signalsUrl ? 'call.called_body' : 'call.called_body_no_link', {
          name: props.botName,
        })}
      </p>
      <a
        href={`tel:${props.phone}`}
        style={{ backgroundColor: props.brandColor }}
        className="mt-5 w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white hover:opacity-90 transition-opacity inline-flex items-center justify-center gap-2"
      >
        <I.phone size={16} aria-hidden="true" />
        {t('voice_call_cta', { phone: props.phoneLabel })}
      </a>
      {props.signalsUrl ? (
        <button
          type="button"
          onClick={() => {
            if (props.signalsUrl) navigateToSignals(props.signalsUrl);
          }}
          className={`mt-3 ${OUTLINE_BUTTON_CLASS}`}
        >
          {t('call.continue_to_signals')}
        </button>
      ) : null}
      <button
        type="button"
        onClick={props.onRegisterAnother}
        className={`mt-3 ${OUTLINE_BUTTON_CLASS}`}
      >
        {t('btn_register_another')}
      </button>
    </div>
  );
}

/** Schema `properties` read loosely, to find a field's `title` and `pattern`. */
const SchemaPropertiesSchema = z.object({
  properties: z.record(
    z.string(),
    z.object({ title: z.string().optional(), pattern: z.string().optional() }).loose(),
  ),
});

/**
 * The identity fields' labels and the phone `pattern`, from the link's schema.
 *
 * @param schema - The link's JSON Schema.
 * @param nameKey - The identity name key.
 * @param phoneKey - The identity phone key.
 * @returns The schema titles (undefined where absent) and the phone pattern.
 */
function identityFieldsOf(
  schema: unknown,
  nameKey: string | undefined,
  phoneKey: string | undefined,
): {
  labels: { name: string | undefined; phone: string | undefined };
  phonePattern: string | undefined;
} {
  const parsed = SchemaPropertiesSchema.safeParse(schema);
  const props = parsed.success ? parsed.data.properties : {};
  const field = (key: string | undefined) =>
    key && Object.hasOwn(props, key) ? props[key] : undefined;
  return {
    labels: { name: field(nameKey)?.title, phone: field(phoneKey)?.title },
    phonePattern: field(phoneKey)?.pattern,
  };
}
