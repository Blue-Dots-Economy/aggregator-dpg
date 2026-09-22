'use client';

/**
 * Shared presentational pieces for the public registration forms.
 *
 * The coordinator (`RegisterView`) and org (`OrgRegisterForm`) forms render an
 * identical error banner and a structurally-identical success panel (only the
 * copy differs). These components hold that markup so the two forms cannot
 * drift. Belongs to `@aggregator-dpg/web`.
 *
 * @module apps/web/src/app/(public)/register/registration-ui
 */

import Link from 'next/link';
import { useEffect, useRef, useState, type RefObject, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import type { IChangeEvent } from '@rjsf/core';
import type { RJSFSchema } from '@rjsf/utils';
import { I } from '../../../icons';
import type { ConsentDoc } from '../../../components/consent/consent-docs';
import type { ConsentDocContent } from '../../../components/consent/consent-types';
import type { ResolvedPlace } from '../../../components/forms/custom-widgets/LocationAutocompleteWidget';
import {
  humaniseValidationErrors,
  type AjvLikeError,
  type SubmitState,
} from './registration-shared';

/** Local form lifecycle shared by the coordinator + org registration forms. */
export interface RegistrationFormState {
  state: SubmitState;
  setState: (s: SubmitState) => void;
  canSubmit: boolean;
  setCanSubmit: (v: boolean) => void;
  /**
   * React 19 folded `MutableRefObject` into `RefObject` and types
   * `useRef<T>(null)` as `RefObject<T | null>` — `.current` genuinely is null
   * until the error banner mounts, so the null belongs in the declared type.
   */
  errorRef: RefObject<HTMLDivElement | null>;
}

/**
 * Holds the submit lifecycle both registration forms share: the `SubmitState`,
 * the validity gate, and an error ref that is scrolled + focused on failure.
 *
 * @returns The form state handles.
 */
export function useRegistrationFormState(): RegistrationFormState {
  const [state, setState] = useState<SubmitState>({ status: 'idle' });
  const [canSubmit, setCanSubmit] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.status === 'error' && errorRef.current) {
      errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      errorRef.current.focus();
    }
  }, [state]);
  return { state, setState, canSubmit, setCanSubmit, errorRef };
}

/** The park-then-gate submit cycle shared by the coordinator + org forms. */
export interface ConsentGateSubmit {
  /** True while the blocking consent gate is open. */
  gateOpen: boolean;
  /** Opens/closes the gate — `false` on cancel and once consent is accepted. */
  setGateOpen: (open: boolean) => void;
  /** Form values parked at submit, replayed once consent is accepted. */
  pendingRef: RefObject<Record<string, unknown> | null>;
  /** RJSF `onSubmit`: parks the payload, then opens the gate. */
  handleSubmit: (e: IChangeEvent<Record<string, unknown>>) => Promise<void>;
}

/**
 * Holds the park-then-gate submit cycle both registration forms share.
 *
 * Neither form POSTs straight from `onSubmit`: consent is collected in the
 * blocking `ConsentGate` first, so the values are parked in a ref for the
 * caller's own accept handler to replay. When the consent copy failed to load
 * (`consentDocs` is empty) the gate would render nothing at all and the form
 * would be stuck with no way to finish or explain why — that case surfaces an
 * error rather than opening a dead gate.
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

  const handleSubmit = async (e: IChangeEvent<Record<string, unknown>>): Promise<void> => {
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
  setCanSubmit: (valid: boolean) => void;
  setState: (s: SubmitState) => void;
  handleSubmit: (e: IChangeEvent<Record<string, unknown>>) => Promise<void>;
  /** The schema the form validates against — used to name fields in errors. */
  formSchema: RJSFSchema;
  // `| undefined` is load-bearing under `exactOptionalPropertyTypes`: both
  // callers pass the prop through explicitly, which an optional-only type
  // rejects.
  consentContent?: ConsentDocContent | undefined;
  /** Where the address widget reports the coordinate it resolved. */
  onLocationResolved: (place: ResolvedPlace | null) => void;
  /** Localised heading for the client-side validation banner. */
  validationErrorTitle: string;
}

/**
 * Builds the RJSF props the coordinator and org registration forms share.
 *
 * The two forms pass an identical block of wiring — form data, validity gate,
 * submit, and the client-side validation banner — differing only in the values
 * they close over. Keeping it here is the same reason the rest of this module
 * exists: the forms are structurally identical and silently drifting apart is
 * the failure that actually happens.
 *
 * Spread the result onto `<RjsfThemedForm>`; `schema` and `uiSchema` stay with
 * the caller, since those genuinely differ.
 *
 * @param wiring - The calling form's state setters, schema and copy.
 * @returns Props to spread onto the themed RJSF form.
 */
export function sharedRegistrationFormProps(wiring: SharedFormWiring): {
  formData: Record<string, unknown>;
  formContext: Record<string, unknown>;
  onChange: (e: IChangeEvent<Record<string, unknown>>) => void;
  onValidityChange: (valid: boolean) => void;
  onSubmit: (e: IChangeEvent<Record<string, unknown>>) => Promise<void>;
  onError: (errs: AjvLikeError[]) => void;
  showErrorList: false;
  focusOnFirstError: true;
  noHtml5Validate: true;
} {
  return {
    formData: wiring.formData,
    // RJSF v6 exposes this to widgets only as `registry.formContext`, never as
    // a prop — see the note in LocationAutocompleteWidget.
    formContext: {
      consentContent: wiring.consentContent,
      onLocationResolved: wiring.onLocationResolved,
    },
    onChange: (e) => wiring.setFormData(e.formData as Record<string, unknown>),
    onValidityChange: wiring.setCanSubmit,
    onSubmit: wiring.handleSubmit,
    onError: (errs) => {
      wiring.setState({
        status: 'error',
        title: wiring.validationErrorTitle,
        detail: humaniseValidationErrors(errs, wiring.formSchema).join('\n'),
        code: 'CLIENT_VALIDATION',
        // The raw errors are the only actionable detail for a client-side
        // failure, so they stand in for a server request id.
        requestId: JSON.stringify(errs, null, 2),
      });
    },
    showErrorList: false,
    focusOnFirstError: true,
    noHtml5Validate: true,
  };
}

export interface RegistrationSubmitButtonProps {
  /** True while a submit is in flight. */
  submitting: boolean;
  /** True when the form is valid + otherwise submittable. */
  canSubmit: boolean;
  /** Idle button label. */
  label: string;
  /** In-flight button label. */
  submittingLabel: string;
}

/**
 * The primary submit button shared by both registration forms — same size,
 * brand colours, and disabled styling.
 *
 * @param props - Submitting/validity flags + labels.
 * @returns The submit button element.
 */
export function RegistrationSubmitButton({
  submitting,
  canSubmit,
  label,
  submittingLabel,
}: RegistrationSubmitButtonProps): JSX.Element {
  const disabled = submitting || !canSubmit;
  return (
    <div className="mt-4 flex flex-col gap-3">
      <button
        type="submit"
        disabled={disabled}
        // Same fix as ConsentGate's CTA: `text-white` here and
        // `text-(--bd-primary-600)` in the disabled branch are both "text
        // color" utilities, so which one actually renders depends on
        // Tailwind's internal stylesheet order, not on their order in this
        // string — here `text-white` was winning, leaving white-on-pale
        // (effectively invisible) instead of the intended indigo label.
        // Keeping one background + one text colour always, and only fading
        // opacity when disabled, sidesteps that class-precedence trap
        // entirely and matches the sibling Signals gate's CTA.
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
  /** Raw Ajv dump shown behind a `<details>` for client-validation errors. */
  rawErrors?: string;
}

/**
 * Red alert banner shown on submit failure (server or client validation).
 *
 * @param props - Title, detail lines, focus ref, optional raw-error dump.
 * @returns The error banner element.
 */
export function RegistrationErrorBanner({
  title,
  detail,
  errorRef,
  rawErrors,
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
      {rawErrors ? (
        <details className="mt-2 text-[11px] text-red-500/80">
          <summary className="cursor-pointer">Show raw validation errors</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] bg-red-100/40 rounded-sm p-2 max-h-[200px] overflow-auto">
            {rawErrors}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export interface RegistrationSuccessPanelProps {
  /** Panel heading. */
  heading: string;
  /** Label preceding the reference id (e.g. "Reference ID:"). */
  refLabel: string;
  /** The reference id (aggregator id or org slug). */
  refId: string;
  /** Body copy explaining next steps (review/approval). */
  message: string;
}

/**
 * Emerald success panel shown after a registration submits, with the reference
 * id and a back-to-sign-in link.
 *
 * @param props - Heading, reference label + id, and next-steps copy.
 * @returns The success panel element.
 */
export function RegistrationSuccessPanel({
  heading,
  refLabel,
  refId,
  message,
}: RegistrationSuccessPanelProps): JSX.Element {
  return (
    <div className="mt-8 rounded-[14px] border border-emerald-200 bg-emerald-50 p-6">
      <div className="font-display font-bold text-[18px] text-emerald-800">{heading}</div>
      <p className="text-[14px] text-emerald-700 mt-2">
        {refLabel} <code className="font-mono text-[12.5px]">{refId}</code>
      </p>
      <p className="text-[14px] text-emerald-700 mt-3">{message}</p>
      <Link
        href="/login"
        className="mt-5 inline-flex items-center gap-2 text-[13.5px] text-primary-600 font-semibold hover:underline"
      >
        <I.arrowL size={15} /> Back to sign in
      </Link>
    </div>
  );
}
