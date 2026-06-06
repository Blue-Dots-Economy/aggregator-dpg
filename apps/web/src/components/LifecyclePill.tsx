'use client';

import { useTranslations } from 'next-intl';

export type LifecycleStatus = 'draft' | 'live' | 'paused' | 'account_only';

const TONE: Record<LifecycleStatus, string> = {
  draft: 'bg-amber-100 text-amber-800 border border-amber-200',
  live: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
  paused: 'bg-slate-200 text-slate-700 border border-slate-300',
  account_only: 'bg-slate-100 text-slate-600 border border-slate-200',
};

/**
 * Coloured pill that reflects a signals item's lifecycle status.
 *
 * Back-compat: `undefined` resolves to `'live'`; `null` resolves to `'account_only'`.
 *
 * @param status - The lifecycle from the API, or undefined/null when absent.
 */
export function LifecyclePill({ status }: { status?: LifecycleStatus | null }) {
  const t = useTranslations('Lifecycle');
  const resolved: LifecycleStatus = status === null ? 'account_only' : (status ?? 'live');
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[resolved]}`}
    >
      {t(resolved)}
    </span>
  );
}
