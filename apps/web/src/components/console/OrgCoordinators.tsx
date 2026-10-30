'use client';

/**
 * The coordinators part of the owner's "Your organisation" page: count tiles
 * that filter the list, a name/email search, a status switch, and the table.
 *
 * Filtering and search run in the browser over the rows the page loaded.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  Check,
  Clock,
  Eye,
  UserCheck,
  Users,
  UserX,
  type LucideIcon,
} from 'lucide-react';
import { I } from '../../icons';
import { cn } from '../../lib/cn';
import { initialsOf } from '../../lib/initials';
import { DomainChips } from './DomainChips';
import { ConsoleStatusPill, type ConsoleStatus } from './ConsoleUi';

/** One coordinator row, already shaped by the page. */
export interface OrgCoordinatorRow {
  id: string;
  /** The coordinator's name, or the email when there is no name. */
  name: string;
  /** The email, or `null` when it is already shown as the name. */
  email: string | null;
  /** The organisation name the coordinator registered with. */
  organisation: string;
  status: ConsoleStatus;
  /** The domains served. */
  domains: Array<{ id: string; label: string }>;
}

/** The list filters, matching the count tiles. */
type Filter = 'all' | 'active' | 'pending' | 'inactive';

const FILTERS: readonly Filter[] = ['all', 'active', 'pending', 'inactive'];

/** The icon and colours of each count tile. */
const TILE: Record<Filter, { icon: LucideIcon; badge: string; count: string; selected: string }> = {
  all: {
    icon: Users,
    badge: 'bg-(--bd-primary-50) text-(--bd-primary-600)',
    count: 'text-ink-900',
    selected:
      'border-(--bd-primary) bg-(--bd-primary)/8 shadow-[0_0_0_3px_var(--bd-primary-50)] hover:border-(--bd-primary)',
  },
  active: {
    icon: UserCheck,
    badge: 'bg-emerald-50 text-emerald-600',
    count: 'text-ink-900',
    selected:
      'border-emerald-500 bg-emerald-500/8 shadow-[0_0_0_3px_rgb(16_185_129/0.15)] hover:border-emerald-500',
  },
  pending: {
    icon: Clock,
    badge: 'bg-amber-50 text-amber-600',
    count: 'text-amber-600',
    selected:
      'border-amber-500 bg-amber-500/8 shadow-[0_0_0_3px_rgb(245_158_11/0.15)] hover:border-amber-500',
  },
  inactive: {
    icon: UserX,
    badge: 'bg-rose-50 text-rose-600',
    count: 'text-ink-900',
    selected:
      'border-rose-500 bg-rose-500/8 shadow-[0_0_0_3px_rgb(244_63_94/0.15)] hover:border-rose-500',
  },
};

/** Whether a row matches the search text (already lower-cased). */
function matches(row: OrgCoordinatorRow, query: string): boolean {
  if (!query) return true;
  return `${row.name} ${row.email ?? ''}`.toLowerCase().includes(query);
}

export function OrgCoordinators({
  rows,
  total,
  pending,
  complete,
  allHref,
  networkId = null,
}: Readonly<{
  rows: OrgCoordinatorRow[];
  /** Every coordinator of the organisation, from the API. */
  total: number;
  /** Coordinators waiting for review, from the API. */
  pending: number;
  /** `false` when the organisation has more coordinators than `rows`. */
  complete: boolean;
  /** The full coordinators list for this organisation. */
  allHref: string;
  /** The network id, for network-specific domain icons. */
  networkId?: string | null;
}>) {
  const t = useTranslations('console.org_home');
  const tStatus = useTranslations('console.status');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  /** Tile count: exact from the API, or counted from the loaded rows. */
  function countOf(f: Filter): string {
    if (f === 'all') return String(total);
    if (f === 'pending') return String(pending);
    const n = rows.filter((r) => r.status === f).length;
    return complete ? String(n) : `${n}+`;
  }

  function label(f: Filter): string {
    if (f === 'all') return t('filter_all');
    if (f === 'pending') return t('filter_pending');
    return tStatus(f);
  }

  const q = query.trim().toLowerCase();
  const visible = rows.filter((r) => (filter === 'all' || r.status === filter) && matches(r, q));
  const emptyText = filter === 'pending' && !q ? t('empty_pending') : t('empty');

  return (
    <>
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              'group bd-card bd-shadow flex cursor-pointer items-start justify-between gap-3 px-[18px] py-4 text-left transition-[background-color,border-color,box-shadow,transform] duration-300 ease-out hover:-translate-y-px hover:border-(--bd-primary-100) hover:shadow-md focus-visible:outline-2 focus-visible:outline-(--bd-primary) active:scale-[0.98] motion-reduce:transition-none',
              filter === f && TILE[f].selected,
            )}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-ink-500">{t(`tile.${f}.label`)}</span>
              <span
                className={cn(
                  'font-display text-[28px] font-extrabold leading-tight',
                  f === 'pending' && pending === 0 ? 'text-ink-400' : TILE[f].count,
                )}
              >
                {countOf(f)}
              </span>
              <span className="text-[12px] text-ink-400">
                {f === 'pending' && pending === 0 ? t('tile.pending.none') : t(`tile.${f}.sub`)}
              </span>
              {filter === f ? (
                <span className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-(--bd-primary-600)">
                  <Check size={13} aria-hidden="true" />
                  {t('tile_showing')}
                </span>
              ) : (
                <span className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-(--bd-primary-600) opacity-80 group-hover:opacity-100">
                  {t('tile_show')}
                  <ArrowRight
                    size={13}
                    aria-hidden="true"
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </span>
              )}
            </span>
            <TileIcon filter={f} />
          </button>
        ))}
      </div>

      <section className="bd-card bd-shadow overflow-hidden">
        <header className="flex flex-wrap items-center gap-3 border-b border-(--bd-border-soft) px-[18px] py-3.5">
          <h2 className="flex items-center gap-2 font-display text-[15px] font-bold text-ink-900">
            {t('list_heading')}
            <span className="rounded-full bg-(--bd-border-soft) px-2 text-[12px] font-bold text-ink-500">
              {visible.length}
            </span>
          </h2>
          <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
            <label className="flex h-9 w-full items-center gap-2 rounded-[10px] border border-(--bd-border) bg-(--bd-bg) px-3 text-ink-500 focus-within:border-(--bd-primary) focus-within:bg-(--bd-card) focus-within:shadow-[0_0_0_3px_var(--bd-primary-50)] sm:w-[260px]">
              <I.search size={15} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('search')}
                aria-label={t('search')}
                className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink-900 outline-none"
              />
            </label>
            <div
              role="group"
              aria-label={t('filter_label')}
              className="flex gap-0.5 overflow-x-auto rounded-[10px] bg-(--bd-border-soft) p-[3px]"
            >
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    'h-[30px] whitespace-nowrap rounded-[7px] px-3 text-[12.5px] font-semibold text-ink-500',
                    filter === f && 'bg-(--bd-card) text-ink-900 shadow-sm',
                  )}
                >
                  {label(f)}
                </button>
              ))}
            </div>
          </div>
        </header>

        {visible.length === 0 ? (
          <p className="px-[18px] py-10 text-center text-ink-500">{emptyText}</p>
        ) : (
          <div className="scroll-x max-h-[min(560px,65vh)] overflow-auto overscroll-contain">
            <table className="bd-table">
              <thead className="sticky top-0 z-[1]">
                <tr>
                  <th>{t('col_coordinator')}</th>
                  <th className="hidden lg:table-cell">{t('col_organisation')}</th>
                  <th>{t('col_status')}</th>
                  <th className="hidden lg:table-cell">{t('col_domains')}</th>
                  <th>{t('col_action')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="flex min-w-0 items-center gap-3">
                        <span
                          aria-hidden="true"
                          className="grid h-[34px] w-[34px] flex-none place-items-center rounded-full bg-(--bd-primary-50) text-[12px] font-bold text-(--bd-primary-600)"
                        >
                          {initialsOf(r.name)}
                        </span>
                        <div className="min-w-0">
                          <Link
                            href={`/console/coordinators/${r.id}`}
                            className="block truncate font-bold text-ink-900 hover:text-(--bd-primary-600) hover:underline"
                          >
                            {r.name}
                          </Link>
                          {r.email ? (
                            <div className="truncate text-[12.5px] text-ink-500">{r.email}</div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="hidden text-ink-700 lg:table-cell">{r.organisation}</td>
                    <td>
                      <ConsoleStatusPill status={r.status} />
                    </td>
                    <td className="hidden lg:table-cell">
                      <DomainChips domains={r.domains} networkId={networkId} />
                    </td>
                    <td className="whitespace-nowrap">
                      {r.status === 'pending' ? (
                        <Link
                          href={`/console/coordinators/${r.id}`}
                          className="rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-(--bd-primary-600) hover:bg-(--bd-primary-50)"
                        >
                          {t('review')}
                        </Link>
                      ) : (
                        <Link
                          href={`/console/coordinators/${r.id}`}
                          aria-label={t('view_named', { name: r.name })}
                          title={t('view')}
                          className="inline-grid h-8 w-8 place-items-center rounded-lg text-ink-500 hover:bg-(--bd-primary-50) hover:text-(--bd-primary-600)"
                        >
                          <Eye size={17} />
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {complete ? null : (
          <p className="border-t border-(--bd-border-soft) px-[18px] py-3 text-[12.5px] text-ink-500">
            {t.rich('partial', {
              count: rows.length,
              link: (chunks) => (
                <Link
                  href={allHref}
                  className="font-semibold text-(--bd-primary-600) hover:underline"
                >
                  {chunks}
                </Link>
              ),
            })}
          </p>
        )}
      </section>
    </>
  );
}

/** The tinted icon badge of a count tile. */
function TileIcon({ filter }: Readonly<{ filter: Filter }>) {
  const { icon: Icon, badge } = TILE[filter];
  return (
    <span
      aria-hidden="true"
      className={cn('grid h-10 w-10 flex-none place-items-center rounded-[11px]', badge)}
    >
      <Icon size={20} strokeWidth={2} />
    </span>
  );
}
