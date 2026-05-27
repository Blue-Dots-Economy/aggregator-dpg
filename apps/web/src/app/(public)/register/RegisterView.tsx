'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import { BlueDotsLogo } from '../../../components/ui/BlueDotsLogo';
import { BrandPanel } from '../../../components/login/BrandPanel';
import { I } from '../../../icons';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';

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

interface AjvLikeError {
  name?: string;
  property?: string;
  message?: string;
  params?: Record<string, unknown>;
  schemaPath?: string;
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\.([a-z])/gi, ' $1')
    .replace(/([A-Z])/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

/**
 * Walk a JSON Schema along a dotted path and return the leaf node's `title`
 * if it has one. Falls back to undefined so the caller can pick a sensible
 * substitute (e.g. last path segment, missingProperty).
 */
function lookupTitle(schema: RJSFSchema, dottedPath: string): string | undefined {
  if (!dottedPath) return undefined;
  const segs = dottedPath.split('.').filter(Boolean);
  let cur: unknown = schema;
  for (const seg of segs) {
    if (cur && typeof cur === 'object' && 'properties' in cur) {
      const props = (cur as { properties?: Record<string, unknown> }).properties;
      const next = props?.[seg];
      if (!next) return undefined;
      cur = next;
    } else {
      return undefined;
    }
  }
  if (cur && typeof cur === 'object' && 'title' in cur) {
    return (cur as { title?: string }).title;
  }
  return undefined;
}

/**
 * Convert Ajv-shaped validation errors into user-facing sentences like
 * "Aggregator Type is required" — keyed off the schema `title` for each
 * field. Falls back to a title-cased version of the field key.
 */
function humaniseValidationErrors(errs: AjvLikeError[], schema: RJSFSchema): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of errs) {
    const propPath = (e.property ?? '').replace(/^\./, '');
    const missing = (e.params?.['missingProperty'] as string | undefined) ?? undefined;
    const fullPath = missing ? [propPath, missing].filter(Boolean).join('.') : propPath;
    const titleFromSchema = lookupTitle(schema, fullPath);
    const fallbackKey = missing || fullPath.split('.').pop() || '';
    const resolvedLabel =
      (titleFromSchema && titleFromSchema.trim()) || (fallbackKey && titleCase(fallbackKey)) || '';
    const isRequired = e.name === 'required' || /required/i.test(e.message ?? '');
    const rawMessage = (e.message ?? '').trim();
    // When Ajv can't pin a single property (e.g. anyOf / oneOf branches all
    // failed), fall back to the schemaPath so the user sees at least *which*
    // constraint blew up — beats a vacuous "Form: is invalid".
    let line: string;
    if (resolvedLabel) {
      line = isRequired
        ? `${resolvedLabel} is required`
        : `${resolvedLabel}: ${rawMessage || 'is invalid'}`;
    } else if (rawMessage) {
      // No path but we have a message — show the message standalone.
      line = rawMessage;
    } else {
      // Last resort: surface the schemaPath so we have *some* signal.
      const where = (e.schemaPath ?? '').replace(/^#?\/?/, '');
      line = where ? `Validation failed at ${where}` : 'One or more fields failed validation.';
    }
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out.length > 0 ? out : ['One or more fields failed validation.'];
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
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const brand = cfg.brand.short_name;
  // Controlled form data. The initial value seeds the location card +
  // consent timestamps; onChange keeps our state in sync with RJSF so that
  // a re-render triggered by `state` updates (e.g. showing an error alert)
  // doesn't wipe what the user already typed.
  const [formData, setFormData] = useState<Record<string, unknown>>(() => {
    const now = new Date();
    const oneYear = new Date(now);
    oneYear.setFullYear(oneYear.getFullYear() + 1);
    return {
      locations: [
        {
          geo: { type: 'Point', coordinates: [0, 0] },
          address: { addressCountry: 'IN' },
        },
      ],
      consent: {
        given_at: now.toISOString(),
        valid_till: oneYear.toISOString(),
      },
    };
  });
  const [state, setState] = useState<SubmitState>({ status: 'idle' });
  const errorRef = useRef<HTMLDivElement>(null);

  // On any submit failure (server error or client validation), pull the
  // error banner into view + focus it. The submit button sits far below
  // the banner, so without this a first-time user clicks submit and sees
  // nothing change — the reason is off-screen above the fold.
  useEffect(() => {
    if (state.status === 'error' && errorRef.current) {
      errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      errorRef.current.focus();
    }
  }, [state]);

  // Page header uses the schema title plus a short user-facing tagline. The
  // schema's `description` field is intentionally technical (it documents
  // the API contract) and is hidden from the form UI.
  const headingTitle = (schema.title as string | undefined) ?? 'Aggregator Registration';
  const headingTagline = 'Tell us about your organisation.';

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
    // Refresh consent timestamps at submit so they reflect the actual moment
    // the user clicked, not page-load time.
    const now = new Date();
    const oneYear = new Date(now);
    oneYear.setFullYear(oneYear.getFullYear() + 1);
    const payload = {
      ...(e.formData ?? {}),
      consent: {
        ...((e.formData as Record<string, unknown> | undefined)?.consent ?? {}),
        given_at: now.toISOString(),
        valid_till: oneYear.toISOString(),
      },
    };
    try {
      const res = await fetch('/api/aggregator/register', {
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
            {cfg.brand.logo?.default ? (
              <Image
                src={cfg.brand.logo.default}
                alt={brand}
                width={200}
                height={48}
                priority
                className="h-10 w-auto object-contain object-left"
              />
            ) : (
              <>
                <BlueDotsLogo size={48} />
                <div>
                  <div className="font-display font-bold text-[18px] text-ink-900 leading-none tracking-tight">
                    {brand}
                  </div>
                  <div className="text-[12.5px] text-ink-400 leading-none mt-1.5">
                    Aggregator Portal
                  </div>
                </div>
              </>
            )}
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
                The {brand} team will review your application. Once approved, sign in via {brand}{' '}
                SSO using the email or mobile you registered.
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
                  {state.code === 'CLIENT_VALIDATION' && state.requestId ? (
                    <details className="mt-2 text-[11px] text-red-500/80">
                      <summary className="cursor-pointer">Show raw validation errors</summary>
                      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] bg-red-100/40 rounded p-2 max-h-[200px] overflow-auto">
                        {state.requestId}
                      </pre>
                    </details>
                  ) : null}
                </div>
              ) : null}

              <RjsfThemedForm
                schema={formSchema}
                uiSchema={uiSchema as unknown as UiSchema<Record<string, unknown>>}
                formData={formData}
                onChange={(e) => setFormData(e.formData as Record<string, unknown>)}
                onSubmit={handleSubmit}
                onError={(errs) => {
                  // Convert raw Ajv errors into human-readable lines using
                  // schema titles. Drop dotted paths like ".contact.phone" in
                  // favour of "Phone is required".
                  const lines = humaniseValidationErrors(errs, formSchema);
                  // Stash a JSON dump of the raw Ajv errors into the detail
                  // payload so when humanise can't resolve a label, the user
                  // can copy-paste the underlying object from the alert
                  // without opening DevTools.
                  const rawDump = JSON.stringify(errs, null, 2);
                  setState({
                    status: 'error',
                    title: 'Please fix the highlighted fields',
                    detail: lines.join('\n'),
                    code: 'CLIENT_VALIDATION',
                    requestId: rawDump,
                  });
                  if (typeof window !== 'undefined') {
                    console.error('[register] validation errors', errs);
                  }
                }}
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
                    {state.status === 'submitting' ? 'Submitting…' : 'Submit application'}
                  </button>
                </div>
              </RjsfThemedForm>

              <div className="mt-5 text-[12px] text-ink-400 flex items-start gap-2">
                <span className="w-1 h-1 rounded-full bg-ink-300 mt-1.5 shrink-0" />
                Your application will be reviewed by the {brand} team. You{'’'}ll receive an email
                once approved, then sign in via {brand} SSO.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
