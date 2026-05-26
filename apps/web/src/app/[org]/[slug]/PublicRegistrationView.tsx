'use client';

import Image from 'next/image';
import { useMemo, useState, type FormEvent } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import { BlueDotsLogo } from '../../../components/ui/BlueDotsLogo';
import { I } from '../../../icons';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';

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
  // Defer required-field error rendering until the user has actually
  // interacted (typed in a field) or attempted submit once. Otherwise
  // RJSF's `liveValidate` paints every required field red on first
  // mount — unfriendly UX for a public-form first impression.
  const [showValidation, setShowValidation] = useState(false);
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const brandShort = cfg.brand.short_name;
  const brandLogo = cfg.brand.logo?.default;

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
    // Inline `items.$ref → #/$defs/<x>` enum hits so RJSF's checkboxes
    // widget receives a populated `enumOptions` list. RJSF's runtime
    // ref-resolver only follows refs through ajv during validation, not
    // when computing widget options — without inlining the array fields
    // render as empty boxes.
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
            // Drop the ref and copy the resolved enum/type onto items
            // in place — RJSF reads from this shape directly.
            const { $ref: _r, ...keep } = items as Record<string, unknown>;
            (inlined[field] as Record<string, unknown>).items = { ...target, ...keep };
          }
        }
        // RJSF only computes a populated `enumOptions` list on the
        // array widget when `uniqueItems: true` is set. The purple_dot
        // schemas omit it, so multi-select dropdowns render with zero
        // options without this nudge.
        const resolvedItems = (inlined[field] as Record<string, unknown>).items as
          | Record<string, unknown>
          | undefined;
        if (resolvedItems && Array.isArray(resolvedItems['enum'])) {
          (inlined[field] as Record<string, unknown>).uniqueItems = true;
        }
      }
    }
    return clone;
  }, [schema]);

  // Default uiSchema cleanups: array fields become a single comma-separated
  // tag input (no "Add another entry" row-builder), boolean / required-string
  // fields span full width so the 2-col grid doesn't strand orphans.
  // Caller-supplied uiSchema entries override these defaults via spread.
  const mergedUiSchema = useMemo<Record<string, unknown>>(() => {
    const props = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
    const defs = (schema as { $defs?: Record<string, Record<string, unknown>> }).$defs ?? {};
    const resolveItemEnum = (itemsDef: Record<string, unknown> | undefined): string[] | null => {
      if (!itemsDef) return null;
      // Direct enum on items.
      if (Array.isArray(itemsDef['enum'])) return itemsDef['enum'] as string[];
      // $ref into $defs (purple_dot schemas pull enums through $defs).
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
            // Array of enum values — render as a multi-select checkbox
            // group so users can only pick allowed values. Bypasses the
            // free-text CommaSeparatedArrayWidget which lets the user
            // type anything and trips Ajv's enum check at submit.
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

  const heroGradient = `linear-gradient(135deg, ${mixHex(cfg.brand.primary_color ?? '#4338ca', '#000', 0.6)} 0%, ${mixHex(cfg.brand.primary_color ?? '#4338ca', '#000', 0.35)} 100%)`;

  return (
    <div
      className="bd-public-light min-h-screen w-full"
      style={{
        background:
          'radial-gradient(1200px 600px at 50% -10%, var(--bd-tint-primary), transparent 70%), #FBFCFE',
      }}
    >
      <div className="max-w-[760px] mx-auto px-4 sm:px-6 lg:px-10 py-8 sm:py-12">
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          {brandLogo ? (
            <Image
              src={brandLogo}
              alt={brandShort}
              width={200}
              height={48}
              priority
              className="h-10 w-auto object-contain object-left"
            />
          ) : (
            <div className="flex items-center gap-3">
              <BlueDotsLogo size={40} />
              <div className="font-display font-bold text-[18px] text-ink-900 leading-none tracking-tight">
                {brandShort}
              </div>
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[11.5px] text-ink-500">
            <I.shield size={13} />
            Secure registration
          </div>
        </header>

        <div className="rounded-[18px] bg-white border border-[var(--bd-border)] overflow-hidden shadow-[0_1px_0_rgba(11,16,32,0.02),0_20px_60px_-30px_rgba(11,16,32,0.18)]">
          <div
            className="px-6 sm:px-8 py-6 text-white relative overflow-hidden"
            style={{ background: heroGradient }}
          >
            <div className="text-[11.5px] uppercase tracking-[0.14em] font-semibold text-white/70">
              {domain === 'seeker' ? 'Seeker registration' : 'Provider registration'}
            </div>
            <h1 className="font-display font-bold text-[24px] sm:text-[28px] tracking-tight leading-tight mt-1.5">
              {eventLabel}
            </h1>
            {(orgName || locationLabel) && (
              <p className="text-[13.5px] text-white/85 mt-1.5">
                {orgName ? <span className="font-semibold">{orgName}</span> : null}
                {orgName && locationLabel ? <span className="text-white/60"> · </span> : null}
                {locationLabel}
              </p>
            )}
          </div>

          <div className="px-6 sm:px-8 py-7">
            {state.status === 'done' ? (
              <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 p-6">
                <div className="flex items-center gap-2.5 font-display font-bold text-[18px] text-emerald-800">
                  <span className="w-7 h-7 rounded-full bg-emerald-500 text-white inline-flex items-center justify-center">
                    <I.check size={16} stroke={2.6} />
                  </span>
                  {state.outcome === 'passed' ? 'Registration received' : 'Already registered'}
                </div>
                <p className="text-[14px] text-emerald-700 mt-3 leading-relaxed">
                  {state.outcome === 'passed'
                    ? 'Thanks — your details have been recorded. You will hear back from the aggregator soon.'
                    : 'A registration with these details already exists for this aggregator. No further action needed.'}
                </p>
                <div className="text-[11px] text-emerald-600/80 font-mono mt-3">
                  Ref: {state.submissionId}
                </div>
              </div>
            ) : (
              <>
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
                  // Only live-validate after the user has typed once OR
                  // attempted submit. Avoids the cold-start "every required
                  // field is red" look on first load.
                  liveValidate={showValidation}
                  showErrorList={showValidation ? 'top' : false}
                  focusOnFirstError
                  noHtml5Validate
                  onError={(errors) => {
                    setShowValidation(true);
                    const first = errors?.[0]?.message ?? 'Please fill all required fields.';
                    setState({
                      status: 'error',
                      title: 'Form validation failed',
                      detail: `${first}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}`,
                      code: 'VALIDATION',
                    });
                  }}
                >
                  <div className="mt-4 flex flex-col gap-3">
                    <button
                      type="submit"
                      disabled={state.status === 'submitting'}
                      style={
                        state.status === 'submitting'
                          ? undefined
                          : { backgroundColor: cfg.brand.primary_color }
                      }
                      className={`w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white transition-all
                    ${
                      state.status === 'submitting'
                        ? 'bg-[var(--bd-primary-100)] text-[var(--bd-primary-600)] cursor-not-allowed'
                        : 'hover:opacity-90 bd-shadow-lg'
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
              </>
            )}
          </div>
        </div>

        <p className="text-center text-[11.5px] text-ink-400 mt-6">
          Powered by{' '}
          <span className="font-semibold" style={{ color: cfg.brand.primary_color }}>
            {brandShort}
          </span>
        </p>
      </div>
    </div>
  );
}

/**
 * Mix two hex colours toward `b`. Used to derive the hero gradient
 * from the brand primary without re-running the ThemeProvider's
 * full ramp logic on this server-rendered page.
 */
function mixHex(a: string, b: string, weight: number): string {
  const parse = (h: string): [number, number, number] | null => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
    if (!m) return null;
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  };
  const A = parse(a);
  const B = parse(b);
  if (!A || !B) return a;
  const w = Math.max(0, Math.min(1, weight));
  const r = Math.round(A[0] * (1 - w) + B[0] * w);
  const g = Math.round(A[1] * (1 - w) + B[1] * w);
  const bl = Math.round(A[2] * (1 - w) + B[2] * w);
  return '#' + [r, g, bl].map((n) => n.toString(16).padStart(2, '0')).join('');
}
