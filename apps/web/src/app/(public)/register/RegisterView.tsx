'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { RJSFSchema } from '@rjsf/utils';
import { BlueDotsLogo } from '../../../components/ui/BlueDotsLogo';
import { BrandPanel } from '../../../components/login/BrandPanel';
import { I } from '../../../icons';
import { useTranslations } from 'next-intl';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';
import { CoordinatorRegisterForm } from './CoordinatorRegisterForm';
import { OrgRegisterForm } from './OrgRegisterForm';

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

type RegisterTab = 'coordinator' | 'org';

/**
 * Registration page shell: brand panel, header, heading, and (flag-on) the
 * Organisation / Coordinator tab switch. Delegates each tab's form to
 * `CoordinatorRegisterForm` / `OrgRegisterForm`.
 *
 * With the org hierarchy off, it renders only the coordinator form — no tabs,
 * no org calls — identical to today.
 *
 * @param props - Coordinator schema/UI schema, the org-hierarchy flag, and
 *   (when on) the org schema/UI schema.
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

  // The org tab exists only when the flag is on AND the server loaded the org
  // schema (defensive: a flag-on network missing the schema file falls back to
  // the coordinator-only form rather than crashing).
  const showTabs = orgHierarchyEnabled && Boolean(orgSchema && orgUiSchema);
  const [tab, setTab] = useState<RegisterTab>('coordinator');

  // Neutral heading when tabs show; keep today's schema-title heading otherwise.
  const headingTitle = showTabs
    ? t('page_title')
    : ((schema.title as string | undefined) ?? 'Aggregator Registration');

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
          <p className="text-[14px] text-ink-500 mt-2">{t('heading_tagline')}</p>

          {showTabs ? (
            <div
              role="tablist"
              aria-label={t('page_title')}
              className="mt-6 grid grid-cols-2 gap-1 w-full max-w-[520px] rounded-[14px] border border-[#e2e8f0] bg-[#eef2f7] p-1"
            >
              {(['coordinator', 'org'] as const).map((key) => {
                const active = tab === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTab(key)}
                    className={`rounded-[11px] px-3 py-[13px] text-center text-[15px] font-semibold tracking-[-0.1px] whitespace-nowrap cursor-pointer transition-[background,color,box-shadow] duration-200 ${
                      active
                        ? 'bg-[var(--bd-primary)] text-white shadow-[0_4px_12px_color-mix(in_srgb,var(--bd-primary)_28%,transparent)]'
                        : 'bg-transparent text-slate-500 hover:text-ink-900'
                    }`}
                  >
                    {key === 'coordinator' ? t('tab_coordinator') : t('tab_org')}
                  </button>
                );
              })}
            </div>
          ) : null}

          {showTabs && tab === 'org' && orgSchema && orgUiSchema ? (
            <OrgRegisterForm schema={orgSchema} uiSchema={orgUiSchema} />
          ) : (
            <CoordinatorRegisterForm
              schema={schema}
              uiSchema={uiSchema}
              orgHierarchyEnabled={orgHierarchyEnabled}
            />
          )}
        </div>
      </div>
    </div>
  );
}
