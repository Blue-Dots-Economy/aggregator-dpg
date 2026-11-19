'use client';

/**
 * Banner on the coordinator Onboarding page while an org owner acts as their
 * own coordinator account: whose onboarding this is, and that counts are the
 * account's own.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { I } from '@/icons';
import { useAuth } from '@/lib/auth-context';

/** Renders the banner while acting until dismissed; nothing otherwise. */
export function ActingBanner() {
  const t = useTranslations('onboarding');
  const { acting, actingOrgName } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  if (!acting || dismissed) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-[12px] border border-(--bd-primary-100) bg-(--bd-tint-primary) px-4 py-3 text-[13px] font-medium text-(--bd-fg)"
    >
      <I.user size={16} className="mt-0.5 shrink-0 text-primary-600" />
      <p className="flex-1">{t('acting_banner', { org: actingOrgName ?? '' })}</p>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={t('acting_banner_dismiss')}
        title={t('acting_banner_dismiss')}
        className="-m-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-(--bd-fg-muted) transition-colors hover:bg-(--bd-border-soft) hover:text-(--bd-fg)"
      >
        <I.x size={14} />
      </button>
    </div>
  );
}
