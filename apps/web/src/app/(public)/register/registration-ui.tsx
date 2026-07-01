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
import { useEffect, useRef, useState, type RefObject } from 'react';
import { I } from '../../../icons';
import type { SubmitState } from './registration-shared';

/** Local form lifecycle shared by the coordinator + org registration forms. */
export interface RegistrationFormState {
  state: SubmitState;
  setState: (s: SubmitState) => void;
  canSubmit: boolean;
  setCanSubmit: (v: boolean) => void;
  errorRef: RefObject<HTMLDivElement>;
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
        className={`w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white transition-all
          ${
            disabled
              ? 'bg-[var(--bd-primary-100)] text-[var(--bd-primary-600)] cursor-not-allowed'
              : 'bg-[var(--bd-primary)] hover:bg-[var(--bd-primary-600)] bd-shadow-lg'
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
  errorRef: RefObject<HTMLDivElement>;
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
      className="mb-5 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700 scroll-mt-6 outline-none"
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
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] bg-red-100/40 rounded p-2 max-h-[200px] overflow-auto">
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
