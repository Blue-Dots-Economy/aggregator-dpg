'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import { I } from '../../../icons';
import {
  humaniseValidationErrors,
  parseError,
  stampConsent,
  type SubmitState,
} from './registration-shared';

export interface OrgRegisterFormProps {
  /** Org-registration JSON Schema loaded by the server component. */
  schema: RJSFSchema;
  /** RJSF UI schema for the org form. */
  uiSchema: Record<string, unknown>;
}

/** Success payload from `POST /api/org/register` → `/v1/orgs/create`. */
interface OrgCreatedResponse {
  org_id: string;
  slug: string;
  status: string;
  message?: string;
}

/**
 * Renders the parent-org registration form (spec §6.1). Submits to the BFF
 * proxy which forwards to `/v1/orgs/create`; on success the org sits `pending`
 * until a network admin approves it. Shown only when the org hierarchy flag is
 * on — the caller gates rendering.
 *
 * @param props - The org JSON Schema + UI schema.
 * @returns The org registration content block (form, success, or error state).
 */
export function OrgRegisterForm({ schema, uiSchema }: OrgRegisterFormProps): JSX.Element {
  const t = useTranslations('register');
  const [formData, setFormData] = useState<Record<string, unknown>>(() => ({
    consent: stampConsent(undefined),
  }));
  const [state, setState] = useState<SubmitState>({ status: 'idle' });
  const [canSubmit, setCanSubmit] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.status === 'error' && errorRef.current) {
      errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      errorRef.current.focus();
    }
  }, [state]);

  // Drop the schema title/description from the rendered form — the page owns
  // the heading and the description is an API-contract note, not UI copy.
  const formSchema = useMemo<RJSFSchema>(() => {
    const clone: RJSFSchema = { ...schema };
    delete (clone as { title?: string }).title;
    delete (clone as { description?: string }).description;
    return clone;
  }, [schema]);

  const handleSubmit = async (
    e: IChangeEvent<Record<string, unknown>>,
    _event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    setState({ status: 'submitting' });
    const payload = {
      ...(e.formData ?? {}),
      consent: stampConsent(
        (e.formData as Record<string, unknown> | undefined)?.consent as
          | Record<string, unknown>
          | undefined,
      ),
    };
    try {
      const res = await fetch('/api/org/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const reqId = res.headers.get('x-request-id') ?? '';
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setState({ status: 'error', ...parseError(body, res.status, reqId) });
        return;
      }
      const body = (await res.json()) as OrgCreatedResponse;
      setState({ status: 'done', refId: body.slug });
    } catch (err) {
      setState({
        status: 'error',
        title: 'Network error',
        detail: err instanceof Error ? err.message : 'Could not reach the server.',
        code: 'NETWORK_ERROR',
        requestId: '',
      });
    }
  };

  if (state.status === 'done') {
    return (
      <div className="mt-8 rounded-[14px] border border-emerald-200 bg-emerald-50 p-6">
        <div className="font-display font-bold text-[18px] text-emerald-800">
          {t('org_success_heading')}
        </div>
        <p className="text-[14px] text-emerald-700 mt-2">
          {t('org_success_slug')} <code className="font-mono text-[12.5px]">{state.refId}</code>
        </p>
        <p className="text-[14px] text-emerald-700 mt-3">{t('org_success_review')}</p>
        <Link
          href="/login"
          className="mt-5 inline-flex items-center gap-2 text-[13.5px] text-primary-600 font-semibold hover:underline"
        >
          <I.arrowL size={15} /> Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-7">
      {state.status === 'error' ? (
        <div
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className="mb-5 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700 scroll-mt-6 outline-none"
        >
          <div className="font-semibold">{state.title}</div>
          {state.detail ? (
            <ul className="mt-1.5 text-red-600 list-disc list-inside space-y-0.5">
              {state.detail
                .split('\n')
                .filter(Boolean)
                .map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <RjsfThemedForm
        schema={formSchema}
        uiSchema={uiSchema as unknown as UiSchema<Record<string, unknown>>}
        formData={formData}
        onChange={(e) => setFormData(e.formData as Record<string, unknown>)}
        onValidityChange={setCanSubmit}
        onSubmit={handleSubmit}
        onError={(errs) => {
          const lines = humaniseValidationErrors(errs, formSchema);
          setState({
            status: 'error',
            title: t('validation_error_title'),
            detail: lines.join('\n'),
            code: 'CLIENT_VALIDATION',
            requestId: JSON.stringify(errs, null, 2),
          });
        }}
        showErrorList={false}
        focusOnFirstError
        noHtml5Validate
      >
        <div className="mt-4 flex flex-col gap-3">
          <button
            type="submit"
            disabled={state.status === 'submitting' || !canSubmit}
            className={`w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white transition-all
              ${
                state.status === 'submitting' || !canSubmit
                  ? 'bg-[var(--bd-primary-100)] text-[var(--bd-primary-600)] cursor-not-allowed'
                  : 'bg-[var(--bd-primary)] hover:bg-[var(--bd-primary-600)] bd-shadow-lg'
              }`}
          >
            {state.status === 'submitting' ? t('submitting') : t('org_submit')}
          </button>
        </div>
      </RjsfThemedForm>
    </div>
  );
}
