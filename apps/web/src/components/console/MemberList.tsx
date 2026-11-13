'use client';

/**
 * A console list of the people or organisations someone invited: count tiles
 * that filter the list, a name/email search, a status switch and one table
 * holding those who joined and those still invited.
 *
 * Filtering and search run in the browser over the rows the page loaded.
 */

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  Building2,
  CircleCheck,
  Clock,
  Eye,
  UserCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { I } from '../../icons';
import { cn } from '../../lib/cn';
import { initialsOf } from '../../lib/initials';
import { CountTile, type TileTone } from './CountTile';
import { ConsoleStatusPill, type ConsoleStatus } from './ConsoleUi';

/** One row, already shaped by the page. */
export interface MemberRow {
  id: string;
  /** The name, or the email when there is no name. */
  name: string;
  /** The line under the name, such as the email or when the invite was sent. */
  detail: string | null;
  status: ConsoleStatus;
  /** The row's page; `null` for an invite nobody has used yet. */
  href: string | null;
  /** One cell per entry of `columns`. */
  cells: ReactNode[];
}

/** The tiles and the list filters: everyone, those who joined, those still invited. */
export type MemberFilter = 'all' | 'active' | 'pending';

const FILTERS: readonly MemberFilter[] = ['all', 'active', 'pending'];

/** What the list holds; picks its copy and its icons. */
type Kind = 'users' | 'orgs';

const COPY: Record<Kind, string> = { users: 'org_home', orgs: 'orgs' };

const TILE: Record<Kind, Record<MemberFilter, { icon: LucideIcon; tone: TileTone }>> = {
  users: {
    all: { icon: Users, tone: 'primary' },
    active: { icon: UserCheck, tone: 'green' },
    pending: { icon: Clock, tone: 'amber' },
  },
  orgs: {
    all: { icon: Building2, tone: 'primary' },
    active: { icon: CircleCheck, tone: 'green' },
    pending: { icon: Clock, tone: 'amber' },
  },
};

/** Whether a row matches the search text (already lower-cased). */
function matches(row: MemberRow, query: string): boolean {
  if (!query) return true;
  return `${row.name} ${row.detail ?? ''}`.toLowerCase().includes(query);
}

export function MemberList({
  kind,
  rows,
  counts,
  columns,
  footer,
  initialFilter = 'all',
}: Readonly<{
  kind: Kind;
  rows: MemberRow[];
  /** Each tile's count, from the API where it has one, else counted from `rows`. */
  counts: Record<MemberFilter, string>;
  /** Headers of the cells after the name and status, shown from the `lg` width. */
  columns: string[];
  /** A note under the table, such as that only part of the list was loaded. */
  footer?: ReactNode;
  initialFilter?: MemberFilter;
}>) {
  const t = useTranslations('console');
  const copy = (key: string) => t(`${COPY[kind]}.${key}`);
  const [filter, setFilter] = useState<MemberFilter>(initialFilter);
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const visible = rows.filter((r) => (filter === 'all' || r.status === filter) && matches(r, q));
  const noneInvited = counts.pending === '0';

  return (
    <>
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-3">
        {FILTERS.map((f) => {
          const Icon = TILE[kind][f].icon;
          return (
            <CountTile
              key={f}
              icon={<Icon size={20} strokeWidth={2} />}
              tone={TILE[kind][f].tone}
              label={copy(`tile.${f}.label`)}
              count={counts[f]}
              sub={
                f === 'pending' && noneInvited ? copy('tile.pending.none') : copy(`tile.${f}.sub`)
              }
              muted={f === 'pending' && noneInvited}
              selected={filter === f}
              showLabel={t('org_home.tile_show')}
              showingLabel={t('org_home.tile_showing')}
              onClick={() => setFilter(f)}
            />
          );
        })}
      </div>

      <section className="bd-card bd-shadow overflow-hidden">
        <header className="flex flex-wrap items-center gap-3 border-b border-(--bd-border-soft) px-[18px] py-3.5">
          <h2 className="flex items-center gap-2 font-display text-[15px] font-bold text-ink-900">
            {copy('list_heading')}
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
                placeholder={copy('search')}
                aria-label={copy('search')}
                className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink-900 outline-none"
              />
            </label>
            <fieldset
              aria-label={copy('filter_label')}
              className="m-0 flex min-w-0 gap-0.5 overflow-x-auto rounded-[10px] border-0 bg-(--bd-border-soft) p-[3px]"
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
                  {f === 'all' ? t('org_home.filter_all') : t(`status.${f}`)}
                </button>
              ))}
            </fieldset>
          </div>
        </header>

        {visible.length === 0 ? (
          <p className="px-[18px] py-10 text-center text-ink-500">{copy('empty')}</p>
        ) : (
          <div className="scroll-x max-h-[min(560px,65vh)] overflow-auto overscroll-contain">
            <table className="bd-table">
              <thead className="sticky top-0 z-[1]">
                <tr>
                  <th>{copy('col_name')}</th>
                  <th>{t('org_home.col_status')}</th>
                  {columns.map((c) => (
                    <th key={c} className="hidden lg:table-cell">
                      {c}
                    </th>
                  ))}
                  <th>{t('org_home.col_action')}</th>
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
                          {r.href ? (
                            <Link
                              href={r.href}
                              className="block truncate font-bold text-ink-900 hover:text-(--bd-primary-600) hover:underline"
                            >
                              {r.name}
                            </Link>
                          ) : (
                            <span className="block truncate font-bold text-ink-900">{r.name}</span>
                          )}
                          {r.detail ? (
                            <div className="truncate text-[12.5px] text-ink-500">{r.detail}</div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td>
                      <ConsoleStatusPill status={r.status} />
                    </td>
                    {r.cells.map((cell, i) => (
                      <td key={columns[i]} className="hidden lg:table-cell">
                        {cell}
                      </td>
                    ))}
                    <td className="whitespace-nowrap">
                      {r.href ? (
                        <Link
                          href={r.href}
                          aria-label={t('org_home.view_named', { name: r.name })}
                          title={t('org_home.view')}
                          className="inline-grid h-8 w-8 place-items-center rounded-lg text-ink-500 hover:bg-(--bd-primary-50) hover:text-(--bd-primary-600)"
                        >
                          <Eye size={17} />
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {footer ? (
          <p className="border-t border-(--bd-border-soft) px-[18px] py-3 text-[12.5px] text-ink-500">
            {footer}
          </p>
        ) : null}
      </section>
    </>
  );
}
