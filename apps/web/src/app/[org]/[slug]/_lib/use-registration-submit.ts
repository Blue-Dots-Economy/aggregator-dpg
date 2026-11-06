/**
 * Submit flow of the public registration page (web app): identity probe,
 * consent gate, POST, and the resulting state.
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ErrorSchema } from '@rjsf/utils';
import type { ConsentDoc } from '@/components/consent/consent-docs';
import type { LinkIdentity } from '@/lib/registration-link';
import { readBirthYear } from './birth-year';
import { postRegistration, probeIdentity, type LookupOutcome } from './registration-api';

/** Where the submit stands. */
export type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'done'; submissionId: string; outcome: 'passed' | 'skipped' }
  | { status: 'error'; title: string; detail: string; code: string };

/** An error banner's content. */
export type SubmitError = Omit<Extract<SubmitState, { status: 'error' }>, 'status'>;

/**
 * One coordinate saved with the profile. `lat`/`lng` must be numbers; Signals rejects strings.
 */
export interface ItemLocation {
  lat: number;
  lng: number;
  label?: string;
}

/** Inputs to {@link useRegistrationSubmit}. */
export interface RegistrationSubmitOptions {
  org: string;
  slug: string;
  /** Signalstack network id for the probe; `''` skips it. */
  network: string;
  domain: string;
  identity: LinkIdentity | undefined;
  /** Whether the domain shows the consent step. */
  showConsent: boolean;
  /** Whether the domain collects the year of birth. */
  showBirthYear: boolean;
  /** `account_only` links send no profile consent and no coordinates. */
  isAccountOnly: boolean;
  /** Documents the consent gate shows. Empty means consent content is missing. */
  consentDocs: ConsentDoc[];
  /** Year of birth from the full-profile form. */
  yearOfBirth: string;
  /** Coordinates the registrant picked. */
  resolvedLocations: ItemLocation[];
  /** Receives server field errors to mark inline. */
  onFieldErrors: (errors: ErrorSchema) => void;
  /** Called when the registration is accepted. */
  onDone: () => void;
}

/** What {@link useRegistrationSubmit} returns. */
export interface RegistrationSubmit {
  state: SubmitState;
  /** Probe outcome that stopped the last submit, or `null`. */
  lookup: LookupOutcome | null;
  /** Probes, opens the consent gate when needed, then posts. */
  submit: (values: Record<string, unknown>) => Promise<void>;
  /** Shows an error banner. */
  fail: (error: SubmitError) => void;
  /** Hides the owned-elsewhere banner. */
  dismissLookup: () => void;
  /** Consent gate state and handlers. */
  gate: { open: boolean; accept: () => void; cancel: () => void };
  /** Back to an empty form for the next participant, consent included. */
  reset: () => void;
}

/**
 * Runs the public registration submit.
 *
 * @param options - Link, domain rules and form state the submit reads.
 * @returns Submit state and handlers.
 */
export function useRegistrationSubmit(options: RegistrationSubmitOptions): RegistrationSubmit {
  const t = useTranslations('profile.public_reg');
  // Reuses the register forms' "consent unavailable" copy.
  const tRegister = useTranslations('register');
  const [state, setState] = useState<SubmitState>({ status: 'idle' });
  /**
   * Pre-submit probe outcome. `null` until the probe runs (or after "allow");
   * `owned_elsewhere` stops the submit and shows its banner.
   */
  const [lookup, setLookup] = useState<LookupOutcome | null>(null);
  // One acceptance covering terms, privacy, and profile creation, collected by
  // ConsentGate. Once true, a retry does not reopen the gate.
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  // Form values held while the consent gate is open, submitted on accept.
  const pendingValuesRef = useRef<Record<string, unknown> | null>(null);
  /**
   * Year of birth for the submit the gate is holding. The account-only form
   * keeps this value in its own state.
   */
  const pendingYobRef = useRef<string | null>(null);

  /**
   * Posts the registration, either directly or after the consent gate is accepted.
   *
   * `consentGiven` is passed in because the `consentAccepted` state update is
   * not visible in this closure until the next render.
   *
   * @param values - Form values.
   * @param consentGiven - Whether to stamp consent_terms/privacy/profile true.
   * @param birthYear - Effective year of birth for this submit.
   */
  const performSubmit = async (
    values: Record<string, unknown>,
    consentGiven: boolean,
    birthYear: string,
  ): Promise<void> => {
    setLookup(null);
    setState({ status: 'submitting' });
    // The server accepts partial profiles (Signals marks them `draft`) and
    // records consent before building the profile. Consent flags are sent
    // only when the domain shows the consent step, and the birth year only
    // when the domain collects it. `consent_profile` is not sent for
    // `account_only`; the server rejects it there.
    const body = {
      ...values,
      ...(options.showConsent
        ? {
            consent_terms: consentGiven,
            consent_privacy: consentGiven,
            ...(options.isAccountOnly ? {} : { consent_profile: consentGiven }),
          }
        : {}),
      ...(options.showBirthYear ? { year_of_birth: birthYear.trim() } : {}),
      // Picked coordinates. Omitted when none, so Signals geocodes the
      // address text. Never sent for account_only, which has no profile.
      ...(!options.isAccountOnly && options.resolvedLocations.length > 0
        ? { item_locations: options.resolvedLocations }
        : {}),
    };
    try {
      const result = await postRegistration(options.org, options.slug, body);
      if (result.kind === 'done') {
        setState({ status: 'done', submissionId: result.submissionId, outcome: result.outcome });
        options.onDone();
        return;
      }
      if (result.fieldErrors) options.onFieldErrors(result.fieldErrors);
      setState({
        status: 'error',
        title: result.error.title ?? t('error_submission_title'),
        detail: result.error.detail ?? t('error_server_detail', { status: result.status }),
        code: result.error.code ?? 'UNKNOWN',
      });
    } catch (err) {
      setState({
        status: 'error',
        title: t('error_network_title'),
        detail: err instanceof Error ? err.message : t('error_network_detail'),
        code: 'NETWORK_ERROR',
      });
    }
  };

  const submit = async (values: Record<string, unknown>): Promise<void> => {
    // Birth year for this submit: from the payload (account-only form) or
    // from the full-profile form's state.
    const yobRaw = values['year_of_birth'];
    const yobForSubmit = typeof yobRaw === 'string' ? yobRaw : options.yearOfBirth;
    const { isMinor } = readBirthYear(yobForSubmit, new Date().getFullYear());
    // Open the consent gate unless the registrant is a minor, the domain has
    // no consent step, or consent was already accepted this session.
    const needsConsentNow = options.showConsent && !isMinor && !consentAccepted;
    // Pre-submit probe; always runs.
    setState({ status: 'submitting' });
    const outcome = await probeIdentity({
      org: options.org,
      slug: options.slug,
      network: options.network,
      domain: options.domain,
      identity: options.identity,
      values,
    });
    if (outcome.kind !== 'allow') {
      setLookup(outcome);
      setState({ status: 'idle' });
      return;
    }
    setLookup(null);

    if (needsConsentNow) {
      // Consent content failed to load; show an error instead of an empty gate.
      if (options.consentDocs.length === 0) {
        setState({
          status: 'error',
          title: tRegister('consent.load_failed_title'),
          detail: tRegister('consent.load_failed_detail'),
          code: 'CONSENT_UNAVAILABLE',
        });
        return;
      }
      pendingValuesRef.current = values;
      pendingYobRef.current = yobForSubmit;
      setGateOpen(true);
      setState({ status: 'idle' });
      return;
    }

    await performSubmit(values, consentAccepted, yobForSubmit);
  };

  return {
    state,
    lookup,
    submit,
    fail: (error) => setState({ status: 'error', ...error }),
    dismissLookup: () => setLookup(null),
    gate: {
      open: gateOpen,
      accept: () => {
        setGateOpen(false);
        setConsentAccepted(true);
        void performSubmit(
          pendingValuesRef.current ?? {},
          true,
          pendingYobRef.current ?? options.yearOfBirth,
        );
      },
      cancel: () => setGateOpen(false),
    },
    reset: () => {
      setState({ status: 'idle' });
      // The next person sees the consent gate and does not inherit the
      // previous person's age.
      setConsentAccepted(false);
      pendingYobRef.current = null;
    },
  };
}
