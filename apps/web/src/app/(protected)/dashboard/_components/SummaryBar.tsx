'use client';

/**
 * Domain summary bar above the dashboard cards (`web` app).
 */
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { I, type IconName } from '@/icons';
import { fmtCount } from '../_lib/format';

/** How long (ms) after a refresh the "Refreshed just now" hint stays eligible to show. */
const REFRESHED_HINT_MS = 5000;

/** Props for {@link SummaryBar}. */
export interface SummaryBarProps {
  icon: IconName;
  label: string;
  total: number | undefined;
  refreshing: boolean;
  refreshError: string | null;
  lastRefreshedAt: number | null;
  onRefresh: () => void;
}

/**
 * Shows the domain's `plural_label`, the live total, a hint, and the refresh action.
 */
export function SummaryBar({
  icon,
  label,
  total,
  refreshing,
  refreshError,
  lastRefreshedAt,
  onRefresh,
}: SummaryBarProps) {
  const t = useTranslations('dashboard');
  const Ic = I[icon];
  return (
    <div className="bd-card bd-shadow px-5 py-4 flex flex-wrap items-center gap-4">
      <div
        className="w-11 h-11 rounded-[12px] flex items-center justify-center shrink-0"
        style={{ background: 'var(--bd-primary-50)', color: 'var(--bd-primary-600)' }}
      >
        <Ic size={22} />
      </div>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[11.5px] font-bold uppercase tracking-[.06em] text-ink-400 truncate">
          {label}
        </span>
        <span className="font-display font-bold text-[18px] text-ink-900 leading-tight">
          {t('summary.total', { count: fmtCount(total) })}
        </span>
      </div>
      <div className="w-px self-stretch bg-(--bd-border) mx-1 hidden sm:block" />
      <span className="text-[13px] text-ink-500 font-medium hidden sm:block">
        {t('summary.hint')}
      </span>
      <div className="ml-auto flex items-center gap-2">
        {refreshError ? (
          <span className="max-w-[220px] truncate text-xs text-red-600" title={refreshError}>
            {t('state.refreshFailed')}
          </span>
        ) : lastRefreshedAt !== null && Date.now() - lastRefreshedAt < REFRESHED_HINT_MS ? (
          <span className="text-xs text-ink-400">{t('state.refreshedJustNow')}</span>
        ) : null}
        <Button
          kind="ghost"
          icon={
            <I.refresh
              size={14}
              className={refreshing ? 'animate-spin' : undefined}
              aria-hidden="true"
            />
          }
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={t('aria.refresh')}
          title={t('aria.refresh')}
        >
          {refreshing ? t('buttons.refreshing') : t('buttons.refresh')}
        </Button>
      </div>
    </div>
  );
}
