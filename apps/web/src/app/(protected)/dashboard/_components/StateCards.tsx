'use client';

/**
 * Loading and error placeholders for the dashboard table (`web` app).
 */
import { useTranslations } from 'next-intl';

/** Placeholder shown while the dashboard query loads. */
export function LoadingCard() {
  const t = useTranslations('dashboard');
  return (
    <div className="bd-card bd-shadow p-8 text-[13px] text-ink-400" style={{ opacity: 0.6 }}>
      {t('state.loading')}
    </div>
  );
}

/** Message shown when the dashboard query fails. */
export function ErrorCard() {
  const t = useTranslations('dashboard');
  return (
    <div className="bd-card bd-shadow p-8 text-[13px] text-rose-600">{t('state.failedToLoad')}</div>
  );
}
