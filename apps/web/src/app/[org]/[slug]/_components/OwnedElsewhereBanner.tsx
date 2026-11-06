'use client';

import type { JSX } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Banner shown when the probe finds the email or phone belongs to another
 * aggregator. The submit does not run.
 */
export function OwnedElsewhereBanner({
  onUseDifferentContact,
}: Readonly<{ onUseDifferentContact: () => void }>): JSX.Element {
  const t = useTranslations('profile.public_reg');
  return (
    <div
      role="alert"
      data-testid="lookup-owned-elsewhere"
      className="mb-5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800"
    >
      <div className="font-semibold">{t('lookup.owned_elsewhere_title')}</div>
      <div className="mt-1 text-amber-700">{t('lookup.owned_elsewhere_body')}</div>
      <button
        type="button"
        onClick={onUseDifferentContact}
        className="mt-3 text-[12px] font-semibold underline text-amber-900 hover:text-amber-700"
      >
        {t('lookup.owned_elsewhere_cta')}
      </button>
    </div>
  );
}
