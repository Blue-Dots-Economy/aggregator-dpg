'use client';

import { useTranslations } from 'next-intl';
import { Topbar } from '@/components/shell/Topbar';
import { I } from '@/icons';
import { OnboardingMetrics } from './OnboardingMetrics';
import { BulkUploadCard, RegistrationLinkCard } from './OnboardingSummaryCards';

/**
 * Client body of the onboarding overview page.
 *
 * Shows the onboarding metrics and the bulk upload and registration link cards.
 */
export function OnboardingView() {
  const t = useTranslations('onboarding');
  return (
    <div className="fade-up flex flex-col gap-3">
      <Topbar
        title={t('title')}
        subtitle={t('subtitle')}
        right={
          <button
            type="button"
            onClick={() => window.location.reload()}
            title={t('refresh')}
            aria-label={t('refresh')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-(--bd-border) bg-white text-[12.5px] font-semibold text-ink-700 hover:text-primary-600 hover:bg-(--bd-primary-50) transition-colors"
          >
            <I.refresh size={14} />
            {t('refresh')}
          </button>
        }
      />
      {/* Onboarding summary and joins by entry mode. */}
      <OnboardingMetrics />
      <BulkUploadCard />
      <RegistrationLinkCard />
    </div>
  );
}
