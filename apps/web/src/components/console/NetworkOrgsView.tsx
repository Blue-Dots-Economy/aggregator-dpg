'use client';

/**
 * The network admin's organisations: status tiles, and the organisations as a
 * tree under the network or as a list with a name search and a status
 * filter. Picking a tile shows the list with that filter.
 *
 * Search and filtering run in the browser over the organisations the page
 * loaded.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eye } from 'lucide-react';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { I } from '../../icons';
import { cn } from '../../lib/cn';
import { ChildOrgsTree } from './ChildOrgsTree';
import { ConsoleStatusPill } from './ConsoleUi';
import {
  ORG_FILTERS,
  OrgStatusTiles,
  countOrgs,
  matchesFilter,
  type OrgFilter,
} from './OrgStatusTiles';

type OrgRow = OrgSearchResponse['orgs'][number];

/** How the organisations are shown. */
export type OrgsView = 'tree' | 'list';

/** Whether an organisation's name or "known as" contains the search text (lower-cased). */
function matchesQuery(org: OrgRow, query: string): boolean {
  if (!query) return true;
  return `${org.name} ${org.known_as_name ?? org.known_as ?? ''}`.toLowerCase().includes(query);
}

export function NetworkOrgsView({
  rootId,
  rootName,
  orgs,
  more,
  initialView = 'tree',
  initialFilter = 'all',
}: Readonly<{
  rootId: string;
  rootName: string;
  orgs: OrgRow[];
  /** More organisations exist than were loaded. */
  more: boolean;
  initialView?: OrgsView;
  initialFilter?: OrgFilter;
}>) {
  const t = useTranslations('console');
  const [view, setView] = useState<OrgsView>(initialView);
  const [filter, setFilter] = useState<OrgFilter>(initialFilter);
  const [query, setQuery] = useState('');

  function pick(f: OrgFilter) {
    setFilter(f);
    setView('list');
  }

  const q = query.trim().toLowerCase();
  const visible = orgs.filter((o) => matchesFilter(o, filter) && matchesQuery(o, q));
  const views: Array<{ id: OrgsView; label: string }> = [
    { id: 'tree', label: t('orgs.view_tree') },
    { id: 'list', label: t('orgs.view_list') },
  ];
  function label(f: OrgFilter): string {
    if (f === 'all') return t('orgs.filter_all');
    if (f === 'pending') return t('orgs.filter_pending');
    return t(`status.${f}`);
  }

  return (
    <>
      <OrgStatusTiles
        counts={countOrgs(orgs)}
        more={more}
        selected={view === 'list' ? filter : null}
        onSelect={pick}
      />

      <section className="bd-card bd-shadow overflow-hidden">
        <header className="flex flex-wrap items-center gap-3 border-b border-(--bd-border-soft) px-[18px] py-3.5">
          <h2 className="flex items-center gap-2 font-display text-[15px] font-bold text-ink-900">
            {t('orgs.network')}
            <span className="rounded-full bg-(--bd-border-soft) px-2 text-[12px] font-bold text-ink-500">
              {view === 'list' ? visible.length : orgs.length}
            </span>
          </h2>
          <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
            {view === 'list' ? (
              <>
                <label className="flex h-9 w-full items-center gap-2 rounded-[10px] border border-(--bd-border) bg-(--bd-bg) px-3 text-ink-500 focus-within:border-(--bd-primary) focus-within:bg-(--bd-card) focus-within:shadow-[0_0_0_3px_var(--bd-primary-50)] sm:w-[240px]">
                  <I.search size={15} />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('orgs.search')}
                    aria-label={t('orgs.search')}
                    className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink-900 outline-none"
                  />
                </label>
                <Segmented
                  label={t('orgs.filter_label')}
                  items={ORG_FILTERS.map((f) => ({ id: f, label: label(f) }))}
                  value={filter}
                  onChange={setFilter}
                />
              </>
            ) : null}
            <Segmented label={t('orgs.view_label')} items={views} value={view} onChange={setView} />
          </div>
        </header>

        {view === 'tree' ? (
          <div className="p-5">
            <ChildOrgsTree
              rootId={rootId}
              rootName={rootName}
              rootKnownAs={null}
              rootTag={t('orgs.network_tag')}
              orgs={orgs}
              linkRows
              more={more}
            />
          </div>
        ) : (
          <OrgsList orgs={visible} more={more} />
        )}
      </section>
    </>
  );
}

/** A small segmented switch of mutually exclusive options. */
function Segmented<T extends string>({
  label,
  items,
  value,
  onChange,
}: Readonly<{
  label: string;
  items: Array<{ id: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex gap-0.5 overflow-x-auto rounded-[10px] bg-(--bd-border-soft) p-[3px]"
    >
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          aria-pressed={value === it.id}
          onClick={() => onChange(it.id)}
          className={cn(
            'h-[30px] whitespace-nowrap rounded-[7px] px-3 text-[12.5px] font-semibold text-ink-500',
            value === it.id && 'bg-(--bd-card) text-ink-900 shadow-sm',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** The organisations as a table with a scrolling body. */
function OrgsList({ orgs, more }: Readonly<{ orgs: OrgRow[]; more: boolean }>) {
  const t = useTranslations('console');
  if (orgs.length === 0) {
    return <p className="px-[18px] py-10 text-center text-ink-500">{t('orgs.empty')}</p>;
  }
  return (
    <>
      <div className="scroll-x max-h-[min(560px,65vh)] overflow-auto overscroll-contain">
        <table className="bd-table">
          <thead className="sticky top-0 z-[1]">
            <tr>
              <th>{t('orgs.col_name')}</th>
              <th className="hidden lg:table-cell">{t('orgs.col_known_as')}</th>
              <th className="hidden lg:table-cell">{t('orgs.col_parent')}</th>
              <th>{t('orgs.col_status')}</th>
              <th>{t('orgs.col_counts')}</th>
              <th className="hidden md:table-cell">{t('orgs.col_children')}</th>
              <th>{t('orgs.col_view')}</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.id}>
                <td>
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-(--bd-primary-50) text-(--bd-primary-600)"
                    >
                      <I.briefcase size={16} />
                    </span>
                    <Link
                      href={`/console/orgs/${o.id}`}
                      className="truncate font-bold text-ink-900 hover:text-(--bd-primary-600) hover:underline"
                    >
                      {o.name}
                    </Link>
                  </div>
                </td>
                <td className="hidden text-ink-700 lg:table-cell">
                  {o.known_as_name ?? o.known_as ?? '—'}
                </td>
                <td className="hidden text-ink-700 lg:table-cell">{o.parent_name ?? '—'}</td>
                <td>
                  <ConsoleStatusPill status={o.status} />
                </td>
                <td className="whitespace-nowrap text-ink-700">
                  {o.coordinator_count}
                  {o.pending_count > 0 ? (
                    <span className="ml-1.5 text-[12px] font-semibold text-amber-600">
                      {t('home.pending', { count: o.pending_count })}
                    </span>
                  ) : null}
                </td>
                <td className="hidden text-ink-700 md:table-cell">{o.child_count}</td>
                <td className="whitespace-nowrap">
                  <Link
                    href={`/console/orgs/${o.id}`}
                    aria-label={t('orgs.view_named', { name: o.name })}
                    title={t('org_home.view')}
                    className="inline-grid h-8 w-8 place-items-center rounded-lg text-ink-500 hover:bg-(--bd-primary-50) hover:text-(--bd-primary-600)"
                  >
                    <Eye size={17} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more ? (
        <p className="border-t border-(--bd-border-soft) px-[18px] py-3 text-[12.5px] text-ink-500">
          {t('org.children_more')}
        </p>
      ) : null}
    </>
  );
}
