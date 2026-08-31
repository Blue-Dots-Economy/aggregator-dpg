'use client';

import { type JSX } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { RJSFSchema } from '@rjsf/utils';
import { BlueDotsLogo } from '../../../../components/ui/BlueDotsLogo';
import { BrandPanel } from '../../../../components/login/BrandPanel';
import { I } from '../../../../icons';
import { useTranslations } from 'next-intl';
import {
  useAggregatorConfig,
  DEFAULT_AGGREGATOR_CONFIG,
} from '../../../../hooks/useAggregatorConfig';
import { OrgRegisterForm } from '../OrgRegisterForm';
import type { ConsentDocContent } from '../../../../components/consent/consent-types';

export interface OwnerRegisterViewProps {
  /** Org-registration JSON Schema loaded by the owner server route. */
  schema: RJSFSchema;
  /** RJSF UI schema for the org form. */
  uiSchema: Record<string, unknown>;
  /**
   * Versioned Terms/Privacy content for the org audience. `null` when
   * `loadConsentConfig` failed — the widget degrades to plain text.
   */
  orgConsentContent?: ConsentDocContent | null;
}

/**
 * Owner (organisation) registration page reached only via the `/register/owner`
 * deep link (#619) — not linked from the public `/register` page. Reuses the
 * same brand-panel chrome as {@link RegisterView} and renders
 * {@link OrgRegisterForm}. The route that renders this view has already
 * asserted the org-hierarchy flag and the presence of the org schema, so this
 * view assumes the owner flow is live.
 *
 * @param props - The org schema/UI schema and org consent content.
 * @returns The owner registration page body.
 */
export function OwnerRegisterView({
  schema,
  uiSchema,
  orgConsentContent,
}: OwnerRegisterViewProps): JSX.Element {
  const t = useTranslations('register');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const brand = cfg.brand.short_name;
  const headingTitle = (schema.title as string | undefined) ?? t('owner_page_title');

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

          <OrgRegisterForm
            schema={schema}
            uiSchema={uiSchema}
            {...(orgConsentContent ? { consentContent: orgConsentContent } : {})}
          />

          <div className="mt-8 flex items-center justify-center gap-3 text-[12.5px] text-ink-500">
            <Link href="/privacy" className="underline-offset-2 hover:text-ink-900 hover:underline">
              {t('consent.privacy_link')}
            </Link>
            <span aria-hidden="true">·</span>
            <Link href="/terms" className="underline-offset-2 hover:text-ink-900 hover:underline">
              {t('consent.terms_link')}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
