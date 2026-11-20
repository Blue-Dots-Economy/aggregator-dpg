'use client';

/**
 * Page frame of the public registration pages (web app, public registration):
 * the brand row with the language switcher, then a card whose coloured band
 * names the domain, the link's event and its organisation and place. The full
 * form and the voice page both render inside it.
 */

import Image from 'next/image';
import type { JSX, ReactNode } from 'react';
import { BlueDotsLogo } from '@/components/ui/BlueDotsLogo';
import { LanguageSwitcher } from '@/components/shell/LanguageSwitcher';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '@/hooks/useAggregatorConfig';

/** Page background used by every state of the public registration page. */
export const PAGE_BACKGROUND =
  'radial-gradient(1200px 600px at 50% -10%, var(--bd-tint-primary), transparent 70%), #FBFCFE';

/** Band colour when the brand sets no primary colour. */
export const FALLBACK_BRAND_COLOR = '#4338ca';

/** Props of {@link RegistrationShell}. */
export interface RegistrationShellProps {
  /** The link's domain id; its label heads the band. */
  domain: string;
  /** The link's context: `title` or `lever_event`, `org_name`, `district`, `state`, `event_location`. */
  context: Record<string, unknown>;
  /** The card body. */
  children: ReactNode;
}

/**
 * Reads a context value that is a non-empty string.
 *
 * @param context - The link's context.
 * @param key - The key to read.
 * @returns The value, or an empty string.
 */
function contextText(context: Record<string, unknown>, key: string): string {
  const value = context[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Renders the public registration page frame around `children`.
 *
 * @param props - Domain, link context and the card body.
 * @returns The page.
 */
export function RegistrationShell({
  domain,
  context,
  children,
}: Readonly<RegistrationShellProps>): JSX.Element {
  const { data: cfgData } = useAggregatorConfig();
  const cfg = cfgData ?? DEFAULT_AGGREGATOR_CONFIG;
  const brandShort = cfg.brand.short_name;
  const brandLogo = cfg.brand.logo?.default;
  const bandColor = cfg.brand.primary_color ?? FALLBACK_BRAND_COLOR;
  const domainCfg = cfg.domains?.find((d) => d.id === domain);
  const domainLabel = domainCfg?.label ?? domainCfg?.plural_label ?? domain;
  const eventLabel =
    contextText(context, 'title') || contextText(context, 'lever_event') || 'Register';
  const orgName = contextText(context, 'org_name');
  const locationLabel = ['district', 'state', 'event_location']
    .map((key) => contextText(context, key))
    .filter((v) => v.length > 0)
    .join(' · ');

  return (
    <div className="bd-public-light min-h-screen w-full" style={{ background: PAGE_BACKGROUND }}>
      <div className="max-w-[760px] mx-auto px-4 sm:px-6 lg:px-10 py-8 sm:py-12">
        <header className="flex items-center justify-between gap-4 mb-6">
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
          <LanguageSwitcher />
        </header>

        <div className="rounded-[18px] bg-white border border-(--bd-border) overflow-hidden shadow-[0_1px_0_rgba(11,16,32,0.02),0_20px_60px_-30px_rgba(11,16,32,0.18)]">
          <div
            className="px-6 sm:px-8 py-6 text-white relative overflow-hidden"
            style={{ background: bandColor }}
          >
            <div className="text-[11.5px] uppercase tracking-[0.14em] font-semibold text-white/70">
              {domainLabel}
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

          <div className="px-6 sm:px-8 py-7">{children}</div>
        </div>
      </div>
    </div>
  );
}
