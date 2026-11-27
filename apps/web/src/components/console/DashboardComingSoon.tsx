'use client';

/**
 * The console dashboard placeholder: two views, each marked "Coming soon".
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ConsoleSection } from './ConsoleUi';
import { cn } from '../../lib/cn';

const VIEWS = ['aggregated', 'participants'] as const;
type View = (typeof VIEWS)[number];

const TAB_KEY: Readonly<Record<View, string>> = {
  aggregated: 'dashboard.tab_aggregated',
  participants: 'dashboard.tab_participants',
};
const BODY_KEY: Readonly<Record<View, string>> = {
  aggregated: 'dashboard.aggregated_body',
  participants: 'dashboard.participants_body',
};

/** Tabs for the two dashboard views and a "Coming soon" card for the chosen one. */
export function DashboardComingSoon() {
  const t = useTranslations('console');
  const [view, setView] = useState<View>('aggregated');
  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label={t('dashboard.tab_label')}
        className="flex w-full gap-1 rounded-[12px] border border-(--bd-border) bg-(--bd-bg) p-1 sm:w-fit"
      >
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn(
              'min-h-11 flex-1 rounded-[9px] px-4 text-[13.5px] font-semibold sm:flex-none',
              view === v
                ? 'bg-(--bd-card) text-(--bd-primary-600) shadow-sm'
                : 'text-ink-500 hover:text-ink-900',
            )}
          >
            {t(TAB_KEY[v])}
          </button>
        ))}
      </div>
      <ConsoleSection>
        <div role="tabpanel" className="flex flex-col items-start gap-2 py-6">
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[12px] font-bold text-amber-800">
            {t('dashboard.coming_soon')}
          </span>
          <h2 className="font-display text-[17px] font-bold text-ink-900">{t(TAB_KEY[view])}</h2>
          <p className="text-[13.5px] text-ink-500">{t(BODY_KEY[view])}</p>
        </div>
      </ConsoleSection>
    </div>
  );
}
