'use client';

import { type JSX, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { BlueDotsLogo } from '../../../components/ui/BlueDotsLogo';
import { LegalLinksFooter } from '../../../components/legal/LegalLinksFooter';
import { BrandPanel } from '../../../components/login/BrandPanel';
import { I } from '../../../icons';
import { useTranslations } from 'next-intl';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';

export interface RegisterPageShellProps {
  /** Page heading rendered above the form (the coordinator/owner title). */
  heading: string;
  /**
   * Sub-heading under the title. Omit to use the default registration tagline;
   * pass `null` to render no tagline (e.g. the invite surfaces, which carry
   * their own intro copy).
   */
  tagline?: string | null;
  /** The registration form (coordinator or org). */
  children: ReactNode;
}

/**
 * Shared chrome for the public registration surfaces — the coordinator page
 * (`RegisterView`) and the owner deep link (`OwnerRegisterView`, #619). Renders
 * the brand panel, header/logo, "back to sign in" link, heading + tagline, the
 * form (`children`), and the Terms/Privacy footer links. Extracted so the two
 * views don't duplicate ~60 lines of identical layout.
 *
 * @param props - The page heading and the form to render.
 * @returns The registration page body.
 */
export function RegisterPageShell({
  heading,
  tagline,
  children,
}: Readonly<RegisterPageShellProps>): JSX.Element {
  const t = useTranslations('register');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const brand = cfg.brand.short_name;

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
            {heading}
          </h1>
          {tagline === null ? null : (
            <p className="text-[14px] text-ink-500 mt-2">{tagline ?? t('heading_tagline')}</p>
          )}

          {children}

          {/* Once the blocking ConsentGate closes, nothing else on this page
              links to the read-only legal page. */}
          <LegalLinksFooter variant="separated" className="mt-8" />
        </div>
      </div>
    </div>
  );
}
