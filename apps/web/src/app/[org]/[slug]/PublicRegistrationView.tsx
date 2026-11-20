'use client';

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { fieldLabel } from '@aggregator-dpg/network-config/field-errors';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import {
  useFieldErrors,
  useFieldErrorCopy,
  withExtraMessages,
} from '@/components/forms/useFieldErrors';
import { FieldMessage, useHandFieldErrors } from '@/components/forms/useHandFieldErrors';
import { serverFieldErrors } from '@/lib/readable-form-errors';
import { requestErrorKind } from '@/lib/request-errors';
import type { ResolvedPlace } from '../../../components/forms/custom-widgets/LocationAutocompleteWidget';
import { RegistrationShell } from './RegistrationShell';
import { I } from '../../../icons';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';
import {
  registrationShowsConsent,
  domainRequiresBirthYear,
  isMinorBirthYear,
  isValidBirthYear,
} from '../../../lib/registration-gates';
import { MinimalIdentityForm, type MinimalIdentityPayload } from './MinimalIdentityForm';
import { SignalsSignInCta, navigateToSignals, useSignalsHandoffUrl } from './SignalsSignInCta';
import { LanguageSwitcher } from '../../../components/shell/LanguageSwitcher';
import { ConsentGate } from '../../../components/consent/ConsentGate';
import { toConsentDocs } from '../../../components/consent/consent-docs';
import type { ParticipantConsent } from '../../../components/consent/consent-types';
import type { LinkIdentity } from '@/lib/registration-link';
import { readErrorEnvelope, type ErrorEnvelope } from '@/lib/api-error';
import { summariseIssues } from '@/lib/response-shape-error';
import { SelectField } from '@/components/ui/SelectField';

/** Page background used by every state of the public registration page. */
const PAGE_BACKGROUND =
  'radial-gradient(1200px 600px at 50% -10%, var(--bd-tint-primary), transparent 70%), #FBFCFE';

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
  /** Open on the form instead of the Register / Sign in chooser. Defaults to false. */
  startWithForm?: boolean;
  /**
   * Called by the form's Back control in place of returning to the chooser.
   * When set, the Back control is always shown on the form.
   */
  onBack?: () => void;
}

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'done'; submissionId: string; outcome: 'passed' | 'skipped' }
  | { status: 'error'; title: string; detail: string };

/**
 * Seconds before the post-submit hand-off to Signals.
 *
 * The success panel is the only place the submission reference id is shown,
 * so this gives the participant time to read it before the page navigates away.
 */
const SIGNALS_REDIRECT_SECONDS = 4;

/**
 * State of the post-submit hand-off countdown.
 *
 * The URL is captured when the countdown starts, so a config refetch during
 * the countdown cannot clear or change it. `navigating` is set before the
 * navigation call, so it fires at most once.
 */
type SignalsHandoff =
  { phase: 'counting'; url: string; seconds: number } | { phase: 'navigating'; url: string };

/**
 * Outcome of the pre-submit identity probe: submit normally, or the identity
 * belongs to a different aggregator.
 */
type LookupOutcome = { kind: 'allow' } | { kind: 'owned_elsewhere' };

/** `GET /api/:org/:slug/lookup`: the field the probe reads. */
const LookupResponseSchema = z.object({ owned_elsewhere: z.boolean() });

/**
 * `POST /api/:org/:slug/submit`, both the 201 body and the 409 body.
 * `outcome` is a plain string in the API's contract.
 */
const SubmitResponseSchema = z.object({
  outcome: z.string(),
  submission_id: z.string().optional(),
});

/**
 * Logs the field paths of a response body that does not match its schema.
 *
 * @param url - The request URL.
 * @param body - The parsed body, or `null` when it was not JSON.
 * @param issues - The schema issues.
 */
function logShapeError(url: string, body: unknown, issues: z.core.$ZodIssue[]): void {
  console.error('[public-registration] unexpected response shape', {
    url,
    issues: body === null ? [] : summariseIssues(issues),
  });
}

/**
 * One coordinate saved with the profile. `lat`/`lng` must be numbers; Signals rejects strings.
 */
interface ItemLocation {
  lat: number;
  lng: number;
  label?: string;
}

/** What decides the extra keys on a registration submit body. */
interface SubmitBodyOptions {
  showConsent: boolean;
  consentGiven: boolean;
  isAccountOnly: boolean;
  showBirthYear: boolean;
  birthYear: string;
  locations: ItemLocation[];
}

/**
 * The registration submit body.
 *
 * The server accepts partial profiles (Signals marks them `draft`) and records
 * consent before building the profile. Consent flags are sent only when the
 * domain shows the consent step, and the birth year only when the domain
 * collects it. `consent_profile` is not sent for `account_only`; the server
 * rejects it there.
 *
 * @param values - RJSF formData (or the minimal-identity payload).
 * @param o - The consent, birth-year and location settings for this submit.
 * @returns The JSON body.
 */
function submitBody(
  values: Record<string, unknown>,
  o: SubmitBodyOptions,
): Record<string, unknown> {
  return {
    ...values,
    ...(o.showConsent
      ? {
          consent_terms: o.consentGiven,
          consent_privacy: o.consentGiven,
          ...(o.isAccountOnly ? {} : { consent_profile: o.consentGiven }),
        }
      : {}),
    ...(o.showBirthYear ? { year_of_birth: o.birthYear.trim() } : {}),
    // Picked coordinates. Omitted when none, so Signals geocodes the
    // address text. Never sent for account_only, which has no profile.
    ...(!o.isAccountOnly && o.locations.length > 0 ? { item_locations: o.locations } : {}),
  };
}

/**
 * The done state for a 409 body whose outcome is `skipped` (already registered
 * here), or null for any other 409.
 *
 * @param body - The parsed 409 body.
 * @returns The done state, or null.
 */
function duplicateState(body: unknown): SubmitState | null {
  const dup = SubmitResponseSchema.safeParse(body);
  if (!dup.success || dup.data.outcome !== 'skipped') return null;
  return { status: 'done', submissionId: dup.data.submission_id ?? '', outcome: 'skipped' };
}

/**
 * The done state for an accepted registration. A body that does not match
 * still shows the done screen, without a reference; an error would invite a
 * second submission.
 *
 * @param submitPath - The submit URL, for the shape-error log.
 * @param body - The parsed response body.
 * @returns The done state.
 */
function acceptedState(submitPath: string, body: unknown): SubmitState {
  const accepted = SubmitResponseSchema.safeParse(body);
  if (!accepted.success) logShapeError(submitPath, body, accepted.error.issues);
  return {
    status: 'done',
    submissionId: accepted.success ? (accepted.data.submission_id ?? '') : '',
    outcome: accepted.success && accepted.data.outcome === 'skipped' ? 'skipped' : 'passed',
  };
}

/**
 * The request-error key for a failed submit; logs anything but a network error.
 *
 * @param err - What the submit threw.
 * @returns `network` when the request never reached the server, else `generic`.
 */
function submitFailureKey(err: unknown): 'network' | 'generic' {
  // `fetch` rejects with a TypeError when the request never reached the server.
  if (err instanceof TypeError) return 'network';
  console.error('[public-registration] submit handling failed', {
    error_type: err instanceof Error ? err.name : typeof err,
  });
  return 'generic';
}

/** Readable RJSF errors; kept exported here for existing callers. */
export { readableFormErrors } from '@/lib/readable-form-errors';

/**
 * Maps a schema property's custom markers to a uiSchema entry for a custom widget.
 *
 * Uses the same markers as the Signals profile form:
 *
 *  - `location: "primary" | "secondary"`: address autocomplete. Only a primary
 *    field's picked coordinate is saved.
 *  - `x-reference-source`: autocomplete backed by an external dataset, either a
 *    source id or `{ source, subtitle }`.
 *
 * Exported for tests.
 *
 * @param def - The property's JSON Schema.
 * @param type - The property's declared `type`, used to pick the array variant.
 * @returns A uiSchema entry for the field, or `null` if no marker applies.
 */
export function resolveMarkerUiSchema(
  def: Record<string, unknown>,
  type: unknown,
): Record<string, unknown> | null {
  const locationRole = def['location'];
  if (locationRole === 'primary' || locationRole === 'secondary') {
    const isArray = type === 'array';
    return {
      'ui:widget': isArray ? 'location-multi' : 'location-autocomplete',
      // Only the multi-row array variant spans both columns. The single-value
      // variant stays half width so the cell beside it is not left empty.
      ...(isArray ? { 'ui:colSpan': 2 } : {}),
      'ui:options': { isPrimaryLocation: locationRole === 'primary' },
    };
  }

  const marker = def['x-reference-source'];
  let source: string | undefined;
  let subtitleFields: string[] | undefined;
  if (typeof marker === 'string') {
    source = marker;
  } else if (marker && typeof marker === 'object') {
    const m = marker as { source?: unknown; subtitle?: unknown };
    if (typeof m.source === 'string') source = m.source;
    if (Array.isArray(m.subtitle)) {
      subtitleFields = m.subtitle.filter((s): s is string => typeof s === 'string');
    }
  }
  if (source) {
    return {
      'ui:widget': 'reference-autocomplete',
      // No colSpan: a single input stays half width.
      'ui:options': { source, ...(subtitleFields ? { subtitleFields } : {}) },
    };
  }

  return null;
}

/**
 * Renders the anonymous participant registration form.
 *
 * Submit POSTs to the BFF, which proxies to `/public/v1/registrations/create/:slug`.
 */
/** The identity phone field's `pattern`, so the phone box stores what the schema accepts. */
function identityPhonePattern(schema: unknown, key: string | undefined): string | undefined {
  if (!key || !schema || typeof schema !== 'object') return undefined;
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  const field = props && Object.hasOwn(props, key) ? props[key] : undefined;
  const pattern = (field as { pattern?: unknown } | undefined)?.pattern;
  return typeof pattern === 'string' ? pattern : undefined;
}

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
  startWithForm = false,
  onBack,
}: PublicRegistrationViewProps): JSX.Element {
  const t = useTranslations('profile.public_reg');
  const tRequest = useTranslations('form.request_error');
  const copy = useFieldErrorCopy();
  // Reuses the register forms' "consent unavailable" copy.
  const tRegister = useTranslations('register');
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  /**
   * Whether the user chose "Register" on the chooser. Kept as view state, not
   * a route change, because printed QR codes encode `/<org>/<slug>` exactly.
   * Not used when the Signals hand-off is not configured.
   */
  const [formRevealed, setFormRevealed] = useState(startWithForm);
  const [state, setState] = useState<SubmitState>({ status: 'idle' });
  // Post-submit hand-off. `null` means no countdown is running.
  const [handoff, setHandoff] = useState<SignalsHandoff | null>(null);
  /**
   * Pre-submit probe outcome. `null` until the probe runs (or after "allow");
   * `owned_elsewhere` stops the submit and shows its banner.
   */
  const [lookup, setLookup] = useState<LookupOutcome | null>(null);
  // Server messages for the account-only form, keyed by payload key.
  const [accountOnlyServerErrors, setAccountOnlyServerErrors] = useState<Record<
    string,
    string
  > | null>(null);
  // Coordinates the registrant picked from the address autocomplete, sent as
  // `item_locations` so Signals stores that point. Empty when nothing was
  // picked; Signals then geocodes the address text.
  const [resolvedLocations, setResolvedLocations] = useState<ItemLocation[]>([]);
  // One acceptance covering terms, privacy, and profile creation, collected by
  // ConsentGate. Once true, a retry does not reopen the gate.
  const [consentAccepted, setConsentAccepted] = useState(false);
  // Whether the consent gate is open.
  const [gateOpen, setGateOpen] = useState(false);
  // Form values held while the consent gate is open, submitted on accept.
  const pendingValuesRef = useRef<Record<string, unknown> | null>(null);
  /**
   * Year of birth for the submit the gate is holding. The account-only form
   * keeps this value in its own state.
   */
  const pendingYobRef = useRef<string | null>(null);
  // Age is derived from the birth year; no birthdate is stored. A minor
  // (age <= 18) submits without consent and accepts terms later in the
  // Signalstack app.
  const [yearOfBirth, setYearOfBirth] = useState('');
  const currentYear = new Date().getFullYear();
  const yobValid = isValidBirthYear(yearOfBirth, currentYear);
  const isMinor = isMinorBirthYear(yearOfBirth, currentYear);
  const yobFe = useHandFieldErrors<'year_of_birth'>('public-reg', {
    year_of_birth: yobValid
      ? null
      : { kind: 'required', message: copy.required(t('year_of_birth_label')) },
  });
  const { data: cfgData, isError: cfgFailed } = useAggregatorConfig();
  const cfg = cfgData ?? DEFAULT_AGGREGATOR_CONFIG;
  /**
   * Whether the config query has finished, with data or with an error. Used to
   * pick chooser or form without a flash. On error the form renders without
   * the chooser so participants can still register.
   */
  const configResolved = cfgData !== undefined || cfgFailed;
  // The consent step and birth-year field are set per domain in network.json.
  // See registrationShowsConsent and domainRequiresBirthYear.
  // Signals sign-in URL for existing participants. Resolved before the
  // account-only early return to keep hook order stable.
  const signalsHandoffUrl = useSignalsHandoffUrl(domain, registrationMode ?? null, submissionShape);
  const domainCfg = cfg.domains.find((d) => d.id === domain);
  const showBirthYear = domainRequiresBirthYear(domainCfg);
  const showConsent = registrationShowsConsent(domainCfg);
  const errorRef = useRef<HTMLDivElement>(null);
  // `account_only` renders MinimalIdentityForm instead of the RJSF form. Its
  // submit goes through the same consent gate with terms and privacy only.
  const isAccountOnly = submissionShape === 'account_only';
  // Consent documents for the gate. Empty when content is missing; submit
  // then shows an error instead of opening the gate.
  const consentDocs = useMemo(() => toConsentDocs(consentContent ?? undefined), [consentContent]);
  // One sentence covering terms, privacy, and profile creation.
  const agreeLabel = `${t('consent_accept_prefix')}${t('consent_docs_link')}${t('consent_profile_conjunction')}`;
  // Account-only creates no profile, so its gate shows terms and privacy only.
  // The API rejects `consent_profile` for this shape.
  const accountOnlyConsentDocs = useMemo(
    () =>
      toConsentDocs(
        consentContent
          ? { terms: consentContent.terms, privacy: consentContent.privacy }
          : undefined,
      ),
    [consentContent],
  );
  // Agreement wording without the profile-creation part.
  const accountOnlyAgreeLabel = `${t('consent_accept_prefix')}${t('consent_docs_link')}.`;
  // Documents and wording for the current form shape.
  const activeConsentDocs = isAccountOnly ? accountOnlyConsentDocs : consentDocs;
  const activeAgreeLabel = isAccountOnly ? accountOnlyAgreeLabel : agreeLabel;

  // On failure, scroll the error banner into view and focus it.
  useEffect(() => {
    if (state.status === 'error' && errorRef.current) {
      errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      errorRef.current.focus();
    }
  }, [state]);

  // Start the countdown after a successful submit (`passed` or `skipped`) when
  // the hand-off is configured. A running countdown is kept as is; only a
  // cancel resets it.
  useEffect(() => {
    if (state.status !== 'done' || !signalsHandoffUrl) return;
    setHandoff(
      (prev) =>
        prev ?? { phase: 'counting', url: signalsHandoffUrl, seconds: SIGNALS_REDIRECT_SECONDS },
    );
  }, [state.status, signalsHandoffUrl]);

  useEffect(() => {
    if (handoff?.phase !== 'counting') return;
    if (handoff.seconds <= 0) {
      // Set `navigating` before navigating so this fires only once.
      setHandoff({ phase: 'navigating', url: handoff.url });
      navigateToSignals(handoff.url);
      return;
    }
    // Tick only while still counting, so a pending tick cannot undo a cancel.
    const timer = setTimeout(
      () =>
        setHandoff((prev) =>
          prev?.phase === 'counting' ? { ...prev, seconds: prev.seconds - 1 } : prev,
        ),
      1000,
    );
    return () => clearTimeout(timer);
  }, [handoff]);

  // Remove the schema title/description (the page header has its own) and
  // `participant_id`, which is bulk-upload only; the server creates one.
  const formSchema = useMemo<RJSFSchema>(() => {
    // Deep clone: the transforms below mutate nested objects, which must not
    // leak back into the `schema` prop.
    const clone: RJSFSchema = structuredClone(schema);
    delete (clone as { title?: string }).title;
    delete (clone as { description?: string }).description;
    const props = (clone as { properties?: Record<string, unknown> }).properties;
    if (props && 'participant_id' in props) {
      const { participant_id: _omit, ...rest } = props as Record<string, unknown>;
      (clone as { properties?: Record<string, unknown> }).properties = rest;
    }
    // Partial profiles are accepted: only identity fields stay required.
    // Signals marks an incomplete item `draft`. The server applies the same rule.
    const identityKeys = new Set(
      [identity?.name, identity?.phone, identity?.email].filter(
        (k): k is string => typeof k === 'string' && k.length > 0,
      ),
    );
    const required = (clone as { required?: string[] }).required;
    if (Array.isArray(required)) {
      (clone as { required?: string[] }).required = required.filter((r) => identityKeys.has(r));
    }
    // Inline `items.$ref` to `#/$defs/<x>` so RJSF's checkboxes widget gets its
    // enum options. RJSF does not resolve these refs for widget options.
    const defs = (clone as { $defs?: Record<string, Record<string, unknown>> }).$defs ?? {};
    const inlined = (clone as { properties?: Record<string, Record<string, unknown>> }).properties;
    if (inlined) {
      for (const [field, def] of Object.entries(inlined)) {
        if (def?.['type'] !== 'array') continue;
        const items = def['items'] as Record<string, unknown> | undefined;
        const ref = typeof items?.['$ref'] === 'string' ? (items['$ref'] as string) : null;
        if (ref?.startsWith('#/$defs/')) {
          const target = defs[ref.slice('#/$defs/'.length)];
          if (target) {
            // Replace the ref with the resolved enum/type.
            const { $ref: _r, ...keep } = items as Record<string, unknown>;
            (inlined[field] as Record<string, unknown>).items = { ...target, ...keep };
          }
        }
        // RJSF fills `enumOptions` for array widgets only with `uniqueItems: true`.
        const resolvedItems = (inlined[field] as Record<string, unknown>).items as
          Record<string, unknown> | undefined;
        if (resolvedItems && Array.isArray(resolvedItems['enum'])) {
          (inlined[field] as Record<string, unknown>).uniqueItems = true;
        }
      }
      // RJSF seeds empty arrays and strings, which fail `minItems`/`minLength`.
      // Remove minimum constraints from non-identity fields so an identity-only
      // submit validates. enum/format/type checks stay.
      for (const [field, def] of Object.entries(inlined)) {
        if (identityKeys.has(field) || !def || typeof def !== 'object') continue;
        delete (def as Record<string, unknown>)['minItems'];
        delete (def as Record<string, unknown>)['minLength'];
        delete (def as Record<string, unknown>)['minimum'];
      }
    }
    return clone;
  }, [schema, identity]);
  const fieldErrors = useFieldErrors(formSchema);

  // Default uiSchema: array fields use checkboxes or a comma-separated input,
  // array and boolean fields span full width, and required fields come first.
  // Caller-supplied uiSchema entries override these defaults.
  const mergedUiSchema = useMemo<Record<string, unknown>>(() => {
    const props = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
    const defs = (schema as { $defs?: Record<string, Record<string, unknown>> }).$defs ?? {};
    const resolveItemEnum = (itemsDef: Record<string, unknown> | undefined): string[] | null => {
      if (!itemsDef) return null;
      // Direct enum on items.
      if (Array.isArray(itemsDef['enum'])) return itemsDef['enum'] as string[];
      // $ref into $defs.
      const ref = itemsDef['$ref'];
      if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
        const key = ref.slice('#/$defs/'.length);
        const target = defs[key];
        if (target && Array.isArray(target['enum'])) return target['enum'] as string[];
      }
      return null;
    };
    const required = new Set(
      ((schema as { required?: string[] }).required ?? []).filter((r) => r !== 'participant_id'),
    );
    const defaults: Record<string, unknown> = {};
    const order: string[] = [];
    const tail: string[] = [];
    if (props) {
      for (const [field, def] of Object.entries(props)) {
        if (field === 'participant_id') continue;
        const type = def?.['type'];
        const isRequired = required.has(field);
        if (type === 'array') {
          const items = def?.['items'] as Record<string, unknown> | undefined;
          const itemEnum = resolveItemEnum(items);
          if (itemEnum && itemEnum.length > 0) {
            // Enum arrays use checkboxes so only allowed values can be picked.
            defaults[field] = {
              'ui:widget': 'checkboxes',
              'ui:colSpan': 2,
              items: { 'ui:label': false },
            };
          } else {
            defaults[field] = {
              'ui:widget': 'CommaSeparatedArrayWidget',
              'ui:colSpan': 2,
              'ui:options': { itemLabel: 'entry' },
              items: { 'ui:label': false },
            };
          }
          // Full-width fields go last.
          tail.push(field);
        } else if (type === 'boolean') {
          defaults[field] = { 'ui:colSpan': 2 };
          tail.push(field);
        } else if (isRequired) {
          order.push(field);
        } else {
          tail.push(field);
        }

        // Schema markers override the type-based widget above.
        const marker = resolveMarkerUiSchema(def, type);
        if (marker) defaults[field] = marker;
      }
    }
    // When the schema declares `x-form-layout` sections, use their field order.
    // Otherwise use the required-first order above.
    const layoutOrder = (
      (schema as { 'x-form-layout'?: { sections?: Array<{ fields?: string[] }> } })['x-form-layout']
        ?.sections ?? []
    ).flatMap((section) => section.fields ?? []);

    return {
      'ui:order': layoutOrder.length > 0 ? [...layoutOrder, '*'] : [...order, ...tail, '*'],
      ...defaults,
      ...uiSchema,
      participant_id: { 'ui:widget': 'hidden' },
    };
  }, [schema, uiSchema]);

  /**
   * Checks, before submit, whether the email or phone belongs to another aggregator.
   *
   * Returns `allow` when no identity is given, the network is unknown, the
   * BFF errors, or the contact is not owned elsewhere. A contact with profiles
   * under this aggregator is allowed; a participant may have more than one.
   *
   * @param values - Current RJSF formData.
   * @returns Branching outcome consumed by `handleSubmit`.
   */
  const runIdentityProbe = async (values: Record<string, unknown>): Promise<LookupOutcome> => {
    if (!network) return { kind: 'allow' };
    // Read identity using the network's field names, falling back to common keys.
    const emailKey = identity?.email;
    const phoneKey = identity?.phone;
    const emailRaw = emailKey ? values[emailKey] : values['email'];
    const phoneRaw = phoneKey
      ? values[phoneKey]
      : (values['phone'] ?? values['phone_number'] ?? values['mobile']);
    const email = typeof emailRaw === 'string' && emailRaw.trim().length > 0 ? emailRaw.trim() : '';
    const phone = typeof phoneRaw === 'string' && phoneRaw.trim().length > 0 ? phoneRaw.trim() : '';
    if (!email && !phone) return { kind: 'allow' };
    const qs = new URLSearchParams();
    if (email) qs.set('email', email);
    if (phone) qs.set('phone_number', phone);
    qs.set('network', network);
    qs.set('domain', domain);
    const lookupPath = `/api/${encodeURIComponent(org)}/${encodeURIComponent(slug)}/lookup`;
    let res: Response;
    try {
      res = await fetch(`${lookupPath}?${qs.toString()}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
    } catch {
      // Network error: submit normally; the API handles duplicates.
      return { kind: 'allow' };
    }
    if (!res.ok) return { kind: 'allow' };
    // A body that does not match is treated like a failed probe: submit normally.
    const body: unknown = await res.json().catch(() => null);
    const parsed = LookupResponseSchema.safeParse(body);
    if (!parsed.success) {
      logShapeError(lookupPath, body, parsed.error.issues);
      return { kind: 'allow' };
    }
    if (parsed.data.owned_elsewhere) return { kind: 'owned_elsewhere' };
    // Existing profiles under this aggregator (live, draft, or paused) do not
    // block: the submit creates another profile. Signals enforces the profile
    // limit and returns `PROFILE_LIMIT_REACHED`. `lifecycle_summary` is not read.
    return { kind: 'allow' };
  };

  /**
   * Identity-only submit for `account_only` links.
   *
   * Passes the payload to {@link handleSubmit} as an RJSF-style event.
   */
  const handleMinimalSubmit = async (payload: MinimalIdentityPayload): Promise<void> => {
    await handleSubmit({ formData: payload as unknown as Record<string, unknown> } as IChangeEvent<
      Record<string, unknown>
    >);
  };

  /**
   * Posts the registration, either directly or after the consent gate is accepted.
   *
   * `consentGiven` is passed in because the `consentAccepted` state update is
   * not visible in this closure until the next render. `birthYear` is passed
   * in because the account-only form keeps it in its own state.
   *
   * @param values - RJSF formData (or the minimal-identity payload).
   * @param consentGiven - Whether to stamp consent_terms/privacy/profile true.
   * @param birthYear - Effective year of birth for this submit, already resolved.
   */
  const performSubmit = async (
    values: Record<string, unknown>,
    consentGiven: boolean,
    birthYear: string,
  ): Promise<void> => {
    setLookup(null);
    setState({ status: 'submitting' });
    const submitPath = `/api/${encodeURIComponent(org)}/${encodeURIComponent(slug)}/submit`;
    try {
      const res = await fetch(submitPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The server accepts partial profiles (Signals marks them `draft`)
        // and records consent before building the profile. Consent flags
        // are sent only when the domain shows the consent step, and the
        // birth year only when the domain collects it. `consent_profile`
        // is not sent for `account_only`; the server rejects it there.
        body: JSON.stringify(
          submitBody(values, {
            showConsent,
            consentGiven,
            isAccountOnly,
            showBirthYear,
            birthYear,
            locations: resolvedLocations,
          }),
        ),
      });
      const body: unknown = await res.json().catch(() => null);
      // 409 with outcome=skipped means already registered here; show the done screen.
      if (res.status === 409) {
        const dup = duplicateState(body);
        if (dup) {
          setState(dup);
          return;
        }
      }
      if (!res.ok) {
        const error = readErrorEnvelope(body);
        if (showFieldErrors(error)) {
          setState({ status: 'idle' });
          return;
        }
        setState({
          status: 'error',
          title: t('error_submission_title'),
          detail: submitErrorText(res.status, error),
        });
        return;
      }
      setState(acceptedState(submitPath, body));
    } catch (err) {
      setState({
        status: 'error',
        title: t('error_submission_title'),
        detail: tRequest(submitFailureKey(err)),
      });
    }
  };

  /**
   * Puts a rejected submit's field errors on their fields.
   *
   * @param error - The API's error envelope.
   * @returns True when at least one message landed on a field.
   */
  const showFieldErrors = (error: ErrorEnvelope): boolean => {
    const phoneKey = identity?.phone;
    const fields: Record<string, unknown> =
      withExtraMessages(
        { ...error?.fields },
        error?.code === 'INVALID_PHONE' && phoneKey ? { [phoneKey]: t('error_phone_invalid') } : {},
      ) ?? {};
    if (!isAccountOnly) return fieldErrors.setServerErrors(fields).complete;

    const flat: Record<string, string> = serverFieldErrorsFlat(fields);
    const missing: unknown[] = Array.isArray(fields['missing']) ? fields['missing'] : [];
    for (const key of missing) {
      if (key === 'phone_or_email') {
        const target = identity?.phone ?? identity?.email;
        if (target) flat[target] = t('account_only.errors.contact_required');
      } else if (typeof key === 'string') {
        flat[key] = copy.required(fieldLabel(schema, key));
      }
    }
    // Only the fields MinimalIdentityForm shows can carry a message; any other
    // key (e.g. consent) needs the banner.
    const shown = new Set(
      [identity?.name, identity?.phone, identity?.email, 'year_of_birth'].filter(Boolean),
    );
    const keys = Object.keys(flat);
    const onForm = Object.fromEntries(Object.entries(flat).filter(([key]) => shown.has(key)));
    if (Object.keys(onForm).length > 0) setAccountOnlyServerErrors(onForm);
    return keys.length > 0 && keys.every((key) => shown.has(key));
  };

  /** Top-level field messages from the API's field errors, keyed by field. */
  const serverFieldErrorsFlat = (fields: Record<string, unknown>): Record<string, string> => {
    const out: Record<string, string> = {};
    const mapped = serverFieldErrors(fields, formSchema, copy);
    for (const [key, node] of Object.entries(mapped?.errorSchema ?? {})) {
      const first = node?.__errors?.[0];
      if (first) out[key] = first;
    }
    return out;
  };

  /**
   * One readable sentence for a rejected submit that names no field.
   *
   * @param status - HTTP status.
   * @param error - The API's error envelope.
   * @returns The message for the banner.
   */
  const submitErrorText = (status: number, error: ErrorEnvelope): string => {
    const code = error?.code;
    if (code === 'LINK_NOT_LIVE') return t('error_link_not_live');
    if (code === 'U18_REGISTRATION_REDIRECT') return t('error_u18');
    if (code === 'CONSENT_REQUIRED') return t('error_consent_required');
    if (error?.fields?.['code'] === 'SIGNALSTACK_PROFILE_LIMIT_REACHED') {
      return t('error_profile_limit');
    }
    return tRequest(requestErrorKind(status));
  };

  const handleSubmit = async (e: IChangeEvent<Record<string, unknown>>): Promise<void> => {
    const values = (e.formData ?? {}) as Record<string, unknown>;
    if (!isAccountOnly && showBirthYear && !yobFe.validate()) return;
    setAccountOnlyServerErrors(null);
    // Birth year for this submit: from the payload (account-only form) or
    // from this component's state (full-profile form).
    const yobRaw = values['year_of_birth'];
    const yobForSubmit = typeof yobRaw === 'string' ? yobRaw : yearOfBirth;
    const isMinorForSubmit = isMinorBirthYear(yobForSubmit, currentYear);
    // Open the consent gate unless the registrant is a minor, the domain has
    // no consent step, or consent was already accepted this session.
    const needsConsentNow = showConsent && !isMinorForSubmit && !consentAccepted;
    // Pre-submit probe; always runs.
    setState({ status: 'submitting' });
    const outcome = await runIdentityProbe(values);
    if (outcome.kind !== 'allow') {
      setLookup(outcome);
      setState({ status: 'idle' });
      return;
    }
    setLookup(null);

    if (needsConsentNow) {
      // Consent content failed to load; show an error instead of an empty gate.
      if (activeConsentDocs.length === 0) {
        setState({
          status: 'error',
          title: tRegister('consent.load_failed_title'),
          detail: tRegister('consent.load_failed_detail'),
        });
        return;
      }
      pendingValuesRef.current = values;
      // Keep the birth year too; the account-only form holds it in its own state.
      pendingYobRef.current = yobForSubmit;
      setGateOpen(true);
      setState({ status: 'idle' });
      return;
    }

    await performSubmit(values, consentAccepted, yobForSubmit);
  };

  /** Accepting the gate: records consent, closes it, and resubmits. */
  const handleGateAccept = (): void => {
    setGateOpen(false);
    setConsentAccepted(true);
    void performSubmit(pendingValuesRef.current ?? {}, true, pendingYobRef.current ?? yearOfBirth);
  };

  // Consent gate rendered by both the account-only and full-profile branches.
  const consentGateElement = (
    <ConsentGate
      open={gateOpen}
      docs={activeConsentDocs}
      agreeLabel={activeAgreeLabel}
      onAccept={handleGateAccept}
      onCancel={() => setGateOpen(false)}
    />
  );

  // Hero fill: solid brand primary colour.
  const heroGradient = cfg.brand.primary_color ?? '#4338ca';

  // Show a placeholder until the config query finishes, so the chooser or
  // form does not flash. A failed query also finishes, with no hand-off.
  if (!configResolved) {
    return (
      <div
        className="bd-public-light min-h-screen w-full"
        style={{ background: PAGE_BACKGROUND }}
        aria-busy="true"
      >
        <div
          className={`${isAccountOnly ? 'max-w-[640px]' : 'max-w-[760px]'} mx-auto px-4 sm:px-6 lg:px-10 py-8 sm:py-12`}
        >
          <div
            data-testid="public-reg-loading"
            className="h-[300px] rounded-[18px] border border-(--bd-border) bg-white animate-pulse"
          />
        </div>
      </div>
    );
  }

  // Chooser between Register and Sign in, shown first when the Signals
  // hand-off is configured. Without a hand-off URL the form renders directly.
  const showChooser = signalsHandoffUrl !== null && !formRevealed;

  const chooserPanel = signalsHandoffUrl ? (
    <div data-testid="registration-chooser">
      <h2 className="font-display font-bold text-[19px] text-(--bd-fg) tracking-tight">
        {t('chooser_title')}
      </h2>
      <p className="mt-2 text-[14px] text-ink-500 leading-relaxed">{t('chooser_subtitle')}</p>
      <div className="mt-5 flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setFormRevealed(true)}
          style={{ backgroundColor: cfg.brand.primary_color }}
          className="w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white hover:opacity-90 transition-opacity bd-shadow-lg"
        >
          {t('chooser_register_cta')}
        </button>
        <SignalsSignInCta href={signalsHandoffUrl} />
      </div>
    </div>
  ) : null;

  // Lets the user go back from the form to the chooser, or to the caller's screen.
  const backToChooser =
    onBack || (signalsHandoffUrl && formRevealed) ? (
      <button
        type="button"
        onClick={onBack ?? (() => setFormRevealed(false))}
        className="mb-4 inline-flex items-center gap-1 text-[13px] font-semibold text-ink-500 hover:text-ink-700"
      >
        <I.arrowL size={14} />
        {t('chooser_back')}
      </button>
    ) : null;

  /**
   * Visible label of the hand-off button, with the seconds left while counting.
   *
   * Shows the plain label once navigating. Visual only: the button's
   * accessible name is the plain label.
   */
  const continueToSignalsLabel =
    handoff?.phase === 'counting' && handoff.seconds > 0
      ? t('btn_continue_to_signals_counting', { seconds: handoff.seconds })
      : t('btn_continue_to_signals');

  /** Top margin of "Register another": smaller when the hand-off button is above it. */
  const registerAnotherSpacing = handoff ? 'mt-3' : 'mt-5';

  // Success panel shown after a submit succeeds.
  const donePanel =
    state.status === 'done' ? (
      <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 p-6">
        <div className="flex items-center gap-2.5 font-display font-bold text-[18px] text-emerald-800">
          <span className="w-7 h-7 rounded-full bg-emerald-500 text-white inline-flex items-center justify-center">
            <I.check size={16} stroke={2.6} />
          </span>
          {state.outcome === 'passed' ? t('done_passed_title') : t('done_skipped_title')}
        </div>
        <p className="text-[14px] text-emerald-700 mt-3 leading-relaxed">
          {state.outcome === 'passed' ? t('done_passed_body') : t('done_skipped_body')}
        </p>
        {state.submissionId ? (
          <div className="text-[11px] text-emerald-600/80 font-mono mt-3">
            {t('done_ref_prefix')} {state.submissionId}
          </div>
        ) : null}
        {/* Live region is always mounted so screen readers announce text
            added to it. It announces once, without the per-second count. */}
        <p aria-live="polite" className="sr-only">
          {handoff ? t('signals_redirect_announcement') : ''}
        </p>
        {handoff ? (
          <button
            type="button"
            onClick={() => {
              // Stop the countdown first so it does not navigate a second time.
              const { url } = handoff;
              setHandoff(null);
              navigateToSignals(url);
            }}
            // Fixed accessible name so the per-second label is not announced.
            aria-label={t('btn_continue_to_signals')}
            style={{ backgroundColor: cfg.brand.primary_color }}
            className="mt-5 w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white hover:opacity-90 transition-opacity"
          >
            <span aria-hidden="true">{continueToSignalsLabel}</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setFormData({});
            setState({ status: 'idle' });
            yobFe.reset();
            // Reset consent and birth year for the next person, so they see
            // the consent gate and do not inherit the previous person's age.
            setConsentAccepted(false);
            setYearOfBirth('');
            pendingYobRef.current = null;
            // Cancel the hand-off so back-to-back registrations stay on this page.
            setHandoff(null);
          }}
          // Secondary outline button, below the primary hand-off button.
          className={`${registerAnotherSpacing} w-full py-3 rounded-[12px] border border-(--bd-border) bg-white font-display font-bold text-[15px] text-ink-700 hover:bg-ink-50 transition-colors`}
        >
          {t('btn_register_another')}
        </button>
      </div>
    ) : null;

  // Exactly one of the three panels below is active.
  let activeView: 'done' | 'chooser' | 'form';
  if (state.status === 'done') {
    activeView = 'done';
  } else if (showChooser) {
    activeView = 'chooser';
  } else {
    activeView = 'form';
  }

  // The account-only form stays mounted until `done`, so a failed submit
  // keeps what the participant typed.
  const errorBanner =
    state.status === 'error' ? (
      <div
        ref={errorRef}
        role="alert"
        tabIndex={-1}
        className="mb-5 rounded-[10px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700 scroll-mt-6 outline-hidden"
      >
        <div className="font-semibold">{state.title}</div>
        <div className="mt-1 text-rose-600">{state.detail}</div>
      </div>
    ) : null;

  if (isAccountOnly && state.status !== 'done') {
    return (
      <div
        className="bd-public-light min-h-screen w-full"
        style={{
          background: PAGE_BACKGROUND,
        }}
      >
        <div className="max-w-[640px] mx-auto px-4 sm:px-6 lg:px-10 py-8 sm:py-12">
          <div className="flex justify-end mb-3">
            <LanguageSwitcher />
          </div>
          {showChooser ? (
            <div className="rounded-[18px] bg-white border border-(--bd-border) px-6 sm:px-8 py-7 shadow-[0_1px_0_rgba(11,16,32,0.02),0_20px_60px_-30px_rgba(11,16,32,0.18)]">
              {chooserPanel}
            </div>
          ) : (
            <>
              {backToChooser}
              {errorBanner}
              {lookup?.kind === 'owned_elsewhere' ? (
                <div
                  role="alert"
                  data-testid="lookup-owned-elsewhere"
                  className="mb-5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800"
                >
                  <div className="font-semibold">{t('lookup.owned_elsewhere_title')}</div>
                  <div className="mt-1 text-amber-700">{t('lookup.owned_elsewhere_body')}</div>
                </div>
              ) : null}
              {/* `busy` is the form's only in-flight flag. */}
              <MinimalIdentityForm
                serverErrors={accountOnlyServerErrors}
                identity={identity ?? {}}
                phonePattern={identityPhonePattern(schema, identity?.phone)}
                onSubmit={handleMinimalSubmit}
                brandColor={heroGradient}
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
      </div>
    );
  }

  return (
    <>
      <RegistrationShell domain={domain} context={context}>
        {activeView === 'done' && donePanel}
        {activeView === 'chooser' && chooserPanel}
        {activeView === 'form' && (
          <>
            {backToChooser}
            {errorBanner}

            {lookup?.kind === 'owned_elsewhere' ? (
              <div
                role="alert"
                data-testid="lookup-owned-elsewhere"
                className="mb-5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800"
              >
                <div className="font-semibold">{t('lookup.owned_elsewhere_title')}</div>
                <div className="mt-1 text-amber-700">{t('lookup.owned_elsewhere_body')}</div>
                <button
                  type="button"
                  onClick={() => {
                    setLookup(null);
                    // Clear the identity fields so the user can retry.
                    // Other field values stay.
                    setFormData((prev) => {
                      const next = { ...prev };
                      for (const key of [
                        identity?.email,
                        identity?.phone,
                        'email',
                        'phone',
                        'phone_number',
                        'mobile',
                      ]) {
                        if (key) delete next[key];
                      }
                      return next;
                    });
                  }}
                  className="mt-3 text-[12px] font-semibold underline text-amber-900 hover:text-amber-700"
                >
                  {t('lookup.owned_elsewhere_cta')}
                </button>
              </div>
            ) : null}

            {!isAccountOnly && (
              <RjsfThemedForm
                schema={formSchema}
                uiSchema={mergedUiSchema as unknown as UiSchema<Record<string, unknown>>}
                formData={formData}
                // Location widgets report resolved coordinates here; they
                // read it as `registry.formContext`, not as a prop.
                formContext={{
                  // Keep only lat/lng from the richer `ResolvedPlace`.
                  onLocationResolved: (place: ResolvedPlace | null) =>
                    setResolvedLocations(place ? [{ lat: place.lat, lng: place.lng }] : []),
                  // The multi-value widget already emits this shape.
                  onLocationsResolved: (coords: ItemLocation[]) => setResolvedLocations(coords),
                }}
                onChange={(e, id) => {
                  setFormData(e.formData as Record<string, unknown>);
                  fieldErrors.onFormChange(id, { before: formData, after: e.formData });
                }}
                onSubmit={handleSubmit}
                {...fieldErrors.formProps}
                showErrorList={false}
                focusOnFirstError
                noHtml5Validate
              >
                <div className="mt-4 flex flex-col gap-3">
                  {showBirthYear && (
                    <div>
                      <label className="block">
                        <span className="text-[14px] font-medium text-(--bd-fg)">
                          {t('year_of_birth_label')}
                          <span className="text-rose-500 ml-0.5">*</span>
                        </span>
                        <SelectField
                          {...yobFe.controlProps('year_of_birth')}
                          value={yearOfBirth}
                          onChange={setYearOfBirth}
                          className="mt-1"
                          required
                          placeholder={t('year_of_birth_placeholder')}
                          options={Array.from({ length: 101 }, (_, i) => currentYear - i).map(
                            (y) => ({ value: String(y), label: y }),
                          )}
                        />
                      </label>
                      <FieldMessage
                        id={yobFe.errorId('year_of_birth')}
                        message={yobFe.message('year_of_birth')}
                      />
                    </div>
                  )}
                  {showConsent && isMinor && (
                    // Minor: no consent here; they accept terms in the
                    // Signalstack app later. Submit still proceeds.
                    <div className="rounded-[12px] border border-(--bd-border) bg-(--bd-primary-50) px-4 py-3.5 text-[14px] text-(--bd-fg)">
                      {t('u18_notice')}
                    </div>
                  )}
                  {(() => {
                    // Disabled only in flight; the click shows every field's error.
                    const blocked = state.status === 'submitting';
                    return (
                      <button
                        type="submit"
                        disabled={blocked}
                        onClick={() => {
                          fieldErrors.markAttempted();
                          yobFe.markAttempted();
                        }}
                        // Same background and text colour in both states;
                        // disabled only lowers opacity.
                        style={{ backgroundColor: cfg.brand.primary_color }}
                        className={`w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white transition-all
                ${blocked ? 'cursor-not-allowed opacity-60' : 'hover:opacity-90 bd-shadow-lg'}`}
                      >
                        {state.status === 'submitting' ? t('btn_submitting') : t('btn_submit')}
                      </button>
                    );
                  })()}
                </div>
              </RjsfThemedForm>
            )}
          </>
        )}
      </RegistrationShell>
      {consentGateElement}
    </>
  );
}
