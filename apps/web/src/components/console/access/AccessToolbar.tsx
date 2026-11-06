/**
 * The sticky bar above the catalogue: the tab list, the personal-data
 * filter and the search box.
 */

import { useTranslations } from 'next-intl';
import { Search, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { AccessTab } from './catalogue-filters';

/** The tabs, the personal-data toggle and the search box. */
export function AccessToolbar({
  view,
  roleCount,
  permissionCount,
  personalOnly,
  query,
  onView,
  onTogglePersonal,
  onQuery,
}: Readonly<{
  view: AccessTab;
  roleCount: number;
  /** The number of live permissions. */
  permissionCount: number;
  personalOnly: boolean;
  query: string;
  onView: (tab: AccessTab) => void;
  onTogglePersonal: () => void;
  onQuery: (query: string) => void;
}>) {
  const t = useTranslations('console.access');
  const tabs: ReadonlyArray<{ id: AccessTab; label: string; count: number | null }> = [
    { id: 'roles', label: t('tab_roles'), count: roleCount },
    { id: 'permissions', label: t('tab_permissions'), count: permissionCount },
    { id: 'matrix', label: t('tab_matrix'), count: null },
  ];
  const searchLabel = view === 'roles' ? t('search_roles') : t('search_permissions');
  return (
    <div className="sticky top-0 z-[5] -mx-1 flex flex-wrap items-center justify-between gap-3 bg-(--bd-bg) px-1 py-2.5">
      <div
        role="tablist"
        aria-label={t('title')}
        className="flex gap-0.5 rounded-[12px] border border-(--bd-border) bg-(--bd-card) p-1"
      >
        {tabs.map(({ id, label, count }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => onView(id)}
            className={cn(
              'flex h-[34px] items-center gap-2 rounded-lg px-3.5 text-[13.5px] font-semibold text-ink-500 hover:text-ink-900',
              view === id &&
                'bg-(--bd-primary-50) text-(--bd-primary-600) hover:text-(--bd-primary-600)',
            )}
          >
            {label}
            {count === null ? null : (
              <span
                className={cn(
                  'rounded-full bg-(--bd-border-soft) px-1.5 text-[11px] text-ink-500',
                  view === id && 'bg-(--bd-primary-100) text-(--bd-primary-600)',
                )}
              >
                {count}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <button
          type="button"
          aria-pressed={personalOnly}
          onClick={onTogglePersonal}
          className={cn(
            'flex h-10 items-center gap-2 rounded-[10px] border border-(--bd-border) bg-(--bd-card) px-3 text-[13px] font-semibold text-ink-700',
            personalOnly && 'border-rose-200 bg-rose-50 text-rose-700',
          )}
        >
          <TriangleAlert size={14} aria-hidden="true" />
          {t('personal_only')}
        </button>
        <label className="flex h-10 w-full items-center gap-2 rounded-[10px] border border-(--bd-border) bg-(--bd-card) px-3 text-ink-500 focus-within:border-(--bd-primary) focus-within:shadow-[0_0_0_3px_var(--bd-primary-50)] sm:w-[300px]">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={searchLabel}
            aria-label={searchLabel}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink-900 outline-none"
          />
        </label>
      </div>
    </div>
  );
}
