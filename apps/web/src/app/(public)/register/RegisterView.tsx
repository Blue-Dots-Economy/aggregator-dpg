'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import { BlueDotsLogo } from '../../../components/ui/BlueDotsLogo';
import { BrandPanel } from '../../../components/login/BrandPanel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select';
import { I } from '../../../icons';
import { useTranslations } from 'next-intl';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';
import { jsonFetch } from '../../../services/http';
import { OrgRegisterForm } from './OrgRegisterForm';
import {
  humaniseValidationErrors,
  parseError,
  stampConsent,
  type SubmitState,
} from './registration-shared';

export interface RegisterViewProps {
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
  /** True when `ORG_HIERARCHY_ENABLED` is on — shows org tab + org selector. */
  orgHierarchyEnabled?: boolean;
  /** Org-registration JSON Schema — present only when the flag is on. */
  orgSchema?: RJSFSchema;
  /** Org-registration UI schema — present only when the flag is on. */
  orgUiSchema?: Record<string, unknown>;
}

interface RegistrationResponse {
  aggregator_id: string;
  org_slug?: string;
  message?: string;
}

/** One active-org option for the coordinator dropdown (`GET /api/orgs`). */
interface OrgOption {
  id: string;
  slug: string;
  display_name: string;
}

type RegisterTab = 'coordinator' | 'org';

/**
 * Renders the public registration surface.
 *
 * With the org hierarchy off, this is exactly today's single coordinator form.
 * With it on, it shows two tabs — "Register Organisation" and "Register as
 * Coordinator" — where the coordinator form gains a required organisation
 * selector (spec §6.2) populated from the active-org list.
 *
 * @param props - Coordinator schema/UI schema, the org-hierarchy flag, and
 *   (when the flag is on) the org schema/UI schema.
 * @returns The registration page body.
 */
export function RegisterView({
  schema,
  uiSchema,
  orgHierarchyEnabled = false,
  orgSchema,
  orgUiSchema,
}: RegisterViewProps): JSX.Element {
  const t = useTranslations('register');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const brand = cfg.brand.short_name;

  // The org tab only exists when the flag is on AND the server actually loaded
  // the org schema (defensive: a flag-on network missing the schema file falls
  // back to the coordinator-only form rather than crashing).
  const showTabs = orgHierarchyEnabled && Boolean(orgSchema && orgUiSchema);
  const [tab, setTab] = useState<RegisterTab>('coordinator');

  const [formData, setFormData] = useState<Record<string, unknown>>(() => ({
    locations: [
      {
        geo: { type: 'Point', coordinates: [0, 0] },
        address: { addressCountry: 'IN' },
      },
    ],
    consent: stampConsent(undefined),
  }));
  const [state, setState] = useState<SubmitState>({ status: 'idle' });
  const [canSubmit, setCanSubmit] = useState(false);
  // Coordinator's selected parent org (spec §6.2). Empty until picked.
  const [orgId, setOrgId] = useState<string>('');
  const errorRef = useRef<HTMLDivElement>(null);

  // Fetch the active-org list only when the hierarchy is on. `enabled` keeps
  // the flag-off path free of any org network call.
  const orgsQuery = useQuery({
    queryKey: ['active-orgs'],
    queryFn: () => jsonFetch<{ orgs: OrgOption[] }>('/api/orgs'),
    enabled: orgHierarchyEnabled,
    staleTime: 30_000,
  });
  const orgs = orgsQuery.data?.orgs ?? [];
  const noOrgsYet =
    orgHierarchyEnabled && orgsQuery.isSuccess && !orgsQuery.isError && orgs.length === 0;

  useEffect(() => {
    if (state.status === 'error' && errorRef.current) {
      errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      errorRef.current.focus();
    }
  }, [state]);

  // Page heading: keep today's schema-title heading when the flag is off (no
  // behaviour change); use a neutral, tab-agnostic heading when tabs show.
  const headingTitle = showTabs
    ? t('page_title')
    : ((schema.title as string | undefined) ?? 'Aggregator Registration');
  const headingTagline = t('heading_tagline');

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
    const payload: Record<string, unknown> = {
      ...(e.formData ?? {}),
      consent: stampConsent(
        (e.formData as Record<string, unknown> | undefined)?.consent as
          | Record<string, unknown>
          | undefined,
      ),
    };
    // The API strips `org_id` before RJSF validation and stores it on
    // `aggregators.parent_org_id`. Only sent when the hierarchy is on.
    if (orgHierarchyEnabled && orgId) {
      payload['org_id'] = orgId;
    }
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
      setState({ status: 'done', refId: body.aggregator_id });
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

  const coordinatorContent =
    state.status === 'done' ? (
      <div className="mt-8 rounded-[14px] border border-emerald-200 bg-emerald-50 p-6">
        <div className="font-display font-bold text-[18px] text-emerald-800">
          {t('success_heading')}
        </div>
        <p className="text-[14px] text-emerald-700 mt-2">
          {t('success_ref_id')} <code className="font-mono text-[12.5px]">{state.refId}</code>
        </p>
        <p className="text-[14px] text-emerald-700 mt-3">{t('success_approval', { brand })}</p>
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

        {noOrgsYet ? (
          <div
            role="status"
            className="rounded-[12px] border border-amber-200 bg-amber-50 px-4 py-5 text-[13.5px] text-amber-800"
          >
            {t('coordinator_no_orgs')}
          </div>
        ) : (
          <>
            {orgHierarchyEnabled ? (
              <div className="form-group mb-4">
                <label className="bd-label" htmlFor="coordinator-org">
                  {t('org_selector_label')}
                  <span className="text-rose-500"> *</span>
                </label>
                {orgsQuery.isError ? (
                  <div className="text-[13px] text-red-600 flex items-center gap-2">
                    {t('org_selector_error')}
                    <button
                      type="button"
                      onClick={() => orgsQuery.refetch()}
                      className="text-primary-600 font-semibold hover:underline"
                    >
                      {t('org_selector_retry')}
                    </button>
                  </div>
                ) : (
                  <Select
                    {...(orgId ? { value: orgId } : {})}
                    onValueChange={setOrgId}
                    disabled={orgsQuery.isLoading}
                  >
                    <SelectTrigger id="coordinator-org" aria-required>
                      <SelectValue
                        placeholder={
                          orgsQuery.isLoading
                            ? t('org_selector_loading')
                            : t('org_selector_placeholder')
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {orgs.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
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
                const rawDump = JSON.stringify(errs, null, 2);
                setState({
                  status: 'error',
                  title: t('validation_error_title'),
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
                  disabled={
                    state.status === 'submitting' || !canSubmit || (orgHierarchyEnabled && !orgId)
                  }
                  className={`w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white transition-all
                    ${
                      state.status === 'submitting' || !canSubmit || (orgHierarchyEnabled && !orgId)
                        ? 'bg-[var(--bd-primary-100)] text-[var(--bd-primary-600)] cursor-not-allowed'
                        : 'bg-[var(--bd-primary)] hover:bg-[var(--bd-primary-600)] bd-shadow-lg'
                    }`}
                >
                  {state.status === 'submitting' ? t('submitting') : t('submit')}
                </button>
              </div>
            </RjsfThemedForm>

            <div className="mt-5 text-[12px] text-ink-400 flex items-start gap-2">
              <span className="w-1 h-1 rounded-full bg-ink-300 mt-1.5 shrink-0" />
              {t('footer_note', { brand })}
            </div>
          </>
        )}
      </div>
    );

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

          {showTabs ? (
            <div
              role="tablist"
              aria-label={t('page_title')}
              className="mt-6 inline-flex rounded-[12px] border border-ink-100 bg-white p-1"
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'coordinator'}
                onClick={() => setTab('coordinator')}
                className={`px-4 py-2 rounded-[9px] text-[13.5px] font-semibold transition-colors ${
                  tab === 'coordinator'
                    ? 'bg-[var(--bd-primary)] text-white'
                    : 'text-ink-500 hover:text-ink-900'
                }`}
              >
                {t('tab_coordinator')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'org'}
                onClick={() => setTab('org')}
                className={`px-4 py-2 rounded-[9px] text-[13.5px] font-semibold transition-colors ${
                  tab === 'org'
                    ? 'bg-[var(--bd-primary)] text-white'
                    : 'text-ink-500 hover:text-ink-900'
                }`}
              >
                {t('tab_org')}
              </button>
            </div>
          ) : null}

          {showTabs && tab === 'org' && orgSchema && orgUiSchema ? (
            <OrgRegisterForm schema={orgSchema} uiSchema={orgUiSchema} />
          ) : (
            coordinatorContent
          )}
        </div>
      </div>
    </div>
  );
}
