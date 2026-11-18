'use client';

/**
 * Shared frame of the onboarding sub-pages (Bulk Upload, Registration Links):
 * the top bar with Back and Refresh, the domain access gate, and the
 * profile-type tabs above the page body.
 */

import type { JSX, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Topbar } from '@/components/shell/Topbar';
import { I } from '@/icons';
import { DomainAccessGate } from '@/components/access/DomainAccessGate';
import { ActiveDomainTabs } from '@/components/ui/ActiveDomainTabs';

const TOPBAR_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-(--bd-border) bg-white text-[12.5px] font-semibold text-ink-700 hover:text-primary-600 hover:bg-(--bd-primary-50) transition-colors';

/** Props for {@link OnboardingSubpage}. */
export interface OnboardingSubpageProps {
  /** Page title. */
  title: string;
  /** Line under the title. */
  subtitle: string;
  /** Label of the button back to the Onboarding page. */
  backLabel: string;
  /** Page body, rendered under the profile-type tabs. */
  children: ReactNode;
}

/**
 * Renders an onboarding sub-page inside the shared frame.
 *
 * @returns The page frame with `children` as its body.
 */
export function OnboardingSubpage({
  title,
  subtitle,
  backLabel,
  children,
}: Readonly<OnboardingSubpageProps>): JSX.Element {
  const t = useTranslations('onboarding');
  const router = useRouter();
  return (
    <div className="fade-up flex flex-col gap-5">
      <Topbar
        title={title}
        subtitle={subtitle}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => router.push('/onboarding')}
              className={TOPBAR_BUTTON_CLASS}
            >
              <I.chevL size={14} />
              {backLabel}
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              title={t('refresh')}
              aria-label={t('refresh')}
              className={TOPBAR_BUTTON_CLASS}
            >
              <I.refresh size={14} />
              {t('refresh')}
            </button>
          </div>
        }
      />
      <DomainAccessGate>
        <ActiveDomainTabs className="-mt-2" />
        {children}
      </DomainAccessGate>
    </div>
  );
}
