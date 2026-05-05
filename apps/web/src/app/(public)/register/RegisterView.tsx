'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import { BlueDotsLogo } from '../../../components/ui/BlueDotsLogo';
import { BrandPanel } from '../../../components/login/BrandPanel';
import { I } from '../../../icons';

export interface RegisterViewProps {
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
}

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'done'; aggregatorId: string }
  | { status: 'error'; title: string; detail: string; code: string; requestId: string };

interface RegistrationResponse {
  aggregator_id: string;
  org_slug?: string;
  message?: string;
}

interface ApiErrorEnvelope {
  error?: {
    code?: string;
    title?: string;
    detail?: string;
    requestId?: string;
  };
}

function parseError(
  body: unknown,
  fallbackStatus: number,
  fallbackReqId: string,
): {
  title: string;
  detail: string;
  code: string;
  requestId: string;
} {
  const env = body as ApiErrorEnvelope;
  return {
    title: env?.error?.title ?? 'Submission failed',
    detail: env?.error?.detail ?? `The server returned HTTP ${fallbackStatus}.`,
    code: env?.error?.code ?? 'UNKNOWN',
    requestId: env?.error?.requestId ?? fallbackReqId,
  };
}

/**
 * Renders the aggregator registration form via RJSF using the JSON Schema +
 * UI schema loaded by the server component. POSTs the validated payload to
 * the BFF, which proxies to the API.
 */
export function RegisterView({ schema, uiSchema }: RegisterViewProps): JSX.Element {
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [state, setState] = useState<SubmitState>({ status: 'idle' });

  // Page header uses the schema title plus a short user-facing tagline. The
  // schema's `description` field is intentionally technical (it documents
  // the API contract) and is hidden from the form UI.
  const headingTitle = (schema.title as string | undefined) ?? 'Aggregator Registration';
  const headingTagline = 'Tell us about your organisation. Reviewed within 1–2 business days.';

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
    try {
      const res = await fetch('/api/aggregator/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(e.formData ?? {}),
      });
      const reqId = res.headers.get('x-request-id') ?? '';
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setState({ status: 'error', ...parseError(body, res.status, reqId) });
        return;
      }
      const body = (await res.json()) as RegistrationResponse;
      setState({ status: 'done', aggregatorId: body.aggregator_id });
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

  return (
    <div className="h-screen w-full flex overflow-hidden">
      <BrandPanel />

      <div
        className="flex-1 min-w-0 h-screen relative overflow-y-auto"
        style={{ background: '#FBFCFE' }}
      >
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none opacity-[0.55]"
          style={{
            backgroundImage: 'radial-gradient(rgba(37,99,235,0.07) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
            maskImage: 'radial-gradient(ellipse 80% 70% at 50% 30%, #000 30%, transparent 80%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 80% 70% at 50% 30%, #000 30%, transparent 80%)',
          }}
        />

        <div className="relative z-10 w-full max-w-[640px] mx-auto px-6 lg:px-10 py-10">
          <header className="flex items-center gap-3.5 mb-8">
            <BlueDotsLogo size={48} />
            <div>
              <div className="font-display font-bold text-[18px] text-ink-900 leading-none tracking-tight">
                Blue Dots
              </div>
              <div className="text-[12.5px] text-ink-400 leading-none mt-1.5">
                Aggregator Portal
              </div>
            </div>
          </header>

          <Link
            href="/login"
            className="inline-flex items-center gap-2 text-[13.5px] text-ink-500 hover:text-ink-900 transition-colors"
          >
            <I.arrowL size={15} /> Back to sign in
          </Link>

          <h1 className="font-display font-bold text-[28px] text-ink-900 tracking-tight leading-tight mt-3">
            {headingTitle}
          </h1>
          <p className="text-[14px] text-ink-500 mt-2">{headingTagline}</p>

          {state.status === 'done' ? (
            <div className="mt-8 rounded-[14px] border border-emerald-200 bg-emerald-50 p-6">
              <div className="font-display font-bold text-[18px] text-emerald-800">
                Application received
              </div>
              <p className="text-[14px] text-emerald-700 mt-2">
                Reference ID: <code className="font-mono text-[12.5px]">{state.aggregatorId}</code>
              </p>
              <p className="text-[14px] text-emerald-700 mt-3">
                The Blue Dots team will review your application within 1–2 business days. Once
                approved, sign in via Blue Dots SSO using the email or mobile you registered.
              </p>
              <Link
                href="/login"
                className="mt-5 inline-flex items-center gap-2 text-[13.5px] text-primary-600 font-semibold hover:underline"
              >
                <I.arrowL size={15} /> Back to sign in
              </Link>
            </div>
          ) : (
            <div className="mt-7">
              {state.status === 'error' ? (
                <div
                  role="alert"
                  className="mb-5 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700"
                >
                  <div className="font-semibold">{state.title}</div>
                  <div className="mt-1 text-red-600">{state.detail}</div>
                  {state.requestId || state.code !== 'UNKNOWN' ? (
                    <div className="mt-2 text-[11px] text-red-500/80 font-mono">
                      {state.code !== 'UNKNOWN' ? <span>Code: {state.code}</span> : null}
                      {state.code !== 'UNKNOWN' && state.requestId ? <span> · </span> : null}
                      {state.requestId ? <span>Ref: {state.requestId}</span> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <RjsfThemedForm
                schema={formSchema}
                uiSchema={uiSchema as unknown as UiSchema<Record<string, unknown>>}
                formData={formData}
                onChange={(e) => setFormData(e.formData as Record<string, unknown>)}
                onSubmit={handleSubmit}
                showErrorList={false}
                liveValidate
                noHtml5Validate
              >
                <div className="mt-6 flex flex-col gap-3">
                  <button
                    type="submit"
                    disabled={state.status === 'submitting'}
                    className={`w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white transition-all
                      ${
                        state.status === 'submitting'
                          ? 'bg-[var(--bd-primary-100)] text-[var(--bd-primary-600)] cursor-not-allowed'
                          : 'bg-[var(--bd-primary)] hover:bg-[var(--bd-primary-600)] bd-shadow-lg'
                      }`}
                  >
                    {state.status === 'submitting' ? 'Submitting…' : 'Submit application'}
                  </button>
                </div>
              </RjsfThemedForm>

              <div className="mt-5 text-[12px] text-ink-400 flex items-start gap-2">
                <span className="w-1 h-1 rounded-full bg-ink-300 mt-1.5 shrink-0" />
                Your application will be reviewed by the Blue Dots team. You{'’'}ll receive an email
                once approved, then sign in via Blue Dots SSO.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
