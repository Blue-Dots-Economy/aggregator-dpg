'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import { BlueDotsLogo } from '../../../components/ui/BlueDotsLogo';
import { I } from '../../../icons';

export interface PublicRegistrationViewProps {
  org: string;
  slug: string;
  domain: 'seeker' | 'provider';
  context: Record<string, unknown>;
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
}

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'done'; submissionId: string; outcome: 'passed' | 'skipped' }
  | { status: 'error'; title: string; detail: string; code: string };

interface SubmitResponse {
  outcome: 'passed' | 'skipped';
  submission_id: string;
  /**
   * Server omits this on the public path to avoid leaking the DB row UUID
   * of an existing participant. Kept optional so older builds that did
   * include it still type-check.
   */
  participant_id?: string | null;
  message?: string;
}

interface ApiErrorEnvelope {
  error?: { code?: string; title?: string; detail?: string };
}

/**
 * Renders the anonymous participant-registration form. Slug + domain come
 * from the server resolve; the form schema drives the UI. Submit POSTs to
 * the BFF, which proxies to `/public/v1/registrations/create/:slug`.
 */
export function PublicRegistrationView({
  org,
  slug,
  domain,
  context,
  schema,
  uiSchema,
}: PublicRegistrationViewProps): JSX.Element {
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [state, setState] = useState<SubmitState>({ status: 'idle' });

  // Hide schema's verbose title/description from the form — the page header
  // owns the framing copy. Also drop `participant_id` from the public form:
  // it's a bulk-upload-only field (aggregator-supplied stable ID for dedup).
  // The submit endpoint server-side mints one when missing.
  const formSchema = useMemo<RJSFSchema>(() => {
    const clone: RJSFSchema = { ...schema };
    delete (clone as { title?: string }).title;
    delete (clone as { description?: string }).description;
    const props = (clone as { properties?: Record<string, unknown> }).properties;
    if (props && 'participant_id' in props) {
      const { participant_id: _omit, ...rest } = props as Record<string, unknown>;
      (clone as { properties?: Record<string, unknown> }).properties = rest;
    }
    const required = (clone as { required?: string[] }).required;
    if (Array.isArray(required)) {
      (clone as { required?: string[] }).required = required.filter((r) => r !== 'participant_id');
    }
    return clone;
  }, [schema]);

  // Default uiSchema cleanups: array fields become a single comma-separated
  // tag input (no "Add another entry" row-builder), boolean / required-string
  // fields span full width so the 2-col grid doesn't strand orphans.
  // Caller-supplied uiSchema entries override these defaults via spread.
  const mergedUiSchema = useMemo<Record<string, unknown>>(() => {
    const props = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
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
          defaults[field] = {
            'ui:widget': 'CommaSeparatedArrayWidget',
            'ui:colSpan': 2,
            'ui:options': { itemLabel: 'entry' },
            items: { 'ui:label': false },
          };
          // Long-form fields land last so the short pairs sit tidy on top.
          tail.push(field);
        } else if (type === 'boolean') {
          defaults[field] = { 'ui:colSpan': 2 };
          tail.push(field);
        } else if (isRequired) {
          order.push(field);
        } else {
          tail.push(field);
        }
      }
    }
    return {
      'ui:order': [...order, ...tail, '*'],
      ...defaults,
      ...uiSchema,
      participant_id: { 'ui:widget': 'hidden' },
    };
  }, [schema, uiSchema]);

  const eventLabel =
    (typeof context['title'] === 'string' && (context['title'] as string)) ||
    (typeof context['lever_event'] === 'string' && (context['lever_event'] as string)) ||
    'Register';
  const orgName = typeof context['org_name'] === 'string' ? (context['org_name'] as string) : '';
  const locationLabel = [context['district'], context['state'], context['event_location']]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' · ');

  const handleSubmit = async (
    e: IChangeEvent<Record<string, unknown>>,
    _event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    setState({ status: 'submitting' });
    try {
      const res = await fetch(
        `/api/${encodeURIComponent(org)}/${encodeURIComponent(slug)}/submit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(e.formData ?? {}),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorEnvelope;
        setState({
          status: 'error',
          title: body.error?.title ?? 'Submission failed',
          detail: body.error?.detail ?? `Server returned HTTP ${res.status}.`,
          code: body.error?.code ?? 'UNKNOWN',
        });
        return;
      }
      const body = (await res.json()) as SubmitResponse;
      setState({
        status: 'done',
        submissionId: body.submission_id,
        outcome: body.outcome,
      });
    } catch (err) {
      setState({
        status: 'error',
        title: 'Network error',
        detail: err instanceof Error ? err.message : 'Could not reach the server.',
        code: 'NETWORK_ERROR',
      });
    }
  };

  return (
    <div className="min-h-screen w-full" style={{ background: '#FBFCFE' }}>
      <div className="max-w-[640px] mx-auto px-6 lg:px-10 py-10">
        <header className="flex items-center gap-3.5 mb-8">
          <BlueDotsLogo size={48} />
          <div>
            <div className="font-display font-bold text-[18px] text-ink-900 leading-none tracking-tight">
              Blue Dots
            </div>
            <div className="text-[12.5px] text-ink-400 leading-none mt-1.5">
              {domain === 'seeker' ? 'Seeker registration' : 'Provider registration'}
            </div>
          </div>
        </header>

        <h1 className="font-display font-bold text-[26px] text-ink-900 tracking-tight leading-tight">
          {eventLabel}
        </h1>
        {(orgName || locationLabel) && (
          <p className="text-[13.5px] text-ink-500 mt-2">
            {orgName ? <span className="font-semibold">{orgName}</span> : null}
            {orgName && locationLabel ? <span className="text-ink-300"> · </span> : null}
            {locationLabel}
          </p>
        )}

        {state.status === 'done' ? (
          <div className="mt-8 rounded-[14px] border border-emerald-200 bg-emerald-50 p-6">
            <div className="font-display font-bold text-[18px] text-emerald-800">
              {state.outcome === 'passed' ? 'Registration received' : 'Already registered'}
            </div>
            <p className="text-[14px] text-emerald-700 mt-2">
              {state.outcome === 'passed'
                ? 'Thanks — your details have been recorded. You will hear back from the aggregator soon.'
                : 'A registration with these details already exists for this aggregator. No further action needed.'}
            </p>
            <div className="text-[11px] text-emerald-600/80 font-mono mt-3">
              Ref: {state.submissionId}
            </div>
          </div>
        ) : (
          <div className="mt-7">
            {state.status === 'error' ? (
              <div
                role="alert"
                className="mb-5 rounded-[10px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700"
              >
                <div className="font-semibold">{state.title}</div>
                <div className="mt-1 text-rose-600">{state.detail}</div>
                {state.code !== 'UNKNOWN' && (
                  <div className="mt-2 text-[11px] text-rose-500/80 font-mono">
                    Code: {state.code}
                  </div>
                )}
              </div>
            ) : null}

            <RjsfThemedForm
              schema={formSchema}
              uiSchema={mergedUiSchema as unknown as UiSchema<Record<string, unknown>>}
              formData={formData}
              onChange={(e) => setFormData(e.formData as Record<string, unknown>)}
              onSubmit={handleSubmit}
              showErrorList={false}
              focusOnFirstError
              noHtml5Validate
            >
              <div className="mt-4 flex flex-col gap-3">
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
                  {state.status === 'submitting' ? 'Submitting…' : 'Submit registration'}
                </button>
              </div>
            </RjsfThemedForm>

            <div className="mt-5 text-[12px] text-ink-400 flex items-start gap-2">
              <I.shield size={13} className="mt-0.5 shrink-0" />
              Your details are shared only with the aggregator who issued this link.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
