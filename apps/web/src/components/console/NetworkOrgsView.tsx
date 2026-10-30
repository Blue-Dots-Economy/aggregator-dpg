'use client';

/**
 * The network admin's organisations: a summary of the network with how many
 * organisations it may hold and status filters, then every organisation as a
 * tree under the network or as a flat list. Search and the status filter
 * apply to both views and run in the browser over the loaded organisations.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  Building2,
  CircleCheck,
  CircleX,
  Clock,
  GitBranch,
  Globe,
  List,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { I } from '../../icons';
import { cn } from '../../lib/cn';
import { orgsInTreeOrder } from '../../lib/console-org-options';
import { ORG_FILTERS, countOrgs, matchesFilter, type OrgFilter } from '../../lib/org-filters';
import { ConsoleStatusPill } from './ConsoleUi';
import { CountTile, type TileTone } from './CountTile';

type OrgRow = OrgSearchResponse['orgs'][number];

/** How the organisations are shown. */
export type OrgsView = 'tree' | 'list';

/** Usage at or above this share of the maximum shows in amber. */
const NEAR_LIMIT = 0.8;

const FILTER_TILE: Record<OrgFilter, { icon: LucideIcon; tone: TileTone }> = {
  all: { icon: Building2, tone: 'primary' },
  active: { icon: CircleCheck, tone: 'green' },
  pending: { icon: Clock, tone: 'amber' },
  inactive: { icon: CircleX, tone: 'rose' },
};

/** Columns shared by the header and every row. */
const COLS =
  'grid grid-cols-[minmax(0,1fr)_auto_72px] items-center gap-3.5 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_90px]';

/** Whether an organisation's name or "known as" contains the search text (lower-cased). */
function matchesQuery(org: OrgRow, query: string): boolean {
  if (!query) return true;
  return `${org.name} ${org.known_as_name ?? org.known_as ?? ''}`.toLowerCase().includes(query);
}

export function NetworkOrgsView({
  rootName,
  orgs,
  more,
  totalOrgs,
  maxOrgs,
  initialView = 'tree',
  initialFilter = 'all',
}: Readonly<{
  rootName: string;
  orgs: OrgRow[];
  /** More organisations exist than were loaded. */
  more: boolean;
  /** Organisations counted against the limit, from the hierarchy settings. */
  totalOrgs: number;
  /** The most organisations the network may hold. */
  maxOrgs: number;
  initialView?: OrgsView;
  initialFilter?: OrgFilter;
}>) {
  const t = useTranslations('console');
  const [view, setView] = useState<OrgsView>(initialView);
  const [filter, setFilter] = useState<OrgFilter>(initialFilter);
  const [query, setQuery] = useState('');

  const counts = countOrgs(orgs);
  const q = query.trim().toLowerCase();
  const keep = (o: OrgRow) => matchesFilter(o, filter) && matchesQuery(o, q);
  // Tree lines only make sense when every row is shown.
  const lines = view === 'tree' && filter === 'all' && !q;
  const rows =
    view === 'tree'
      ? orgsInTreeOrder(orgs).filter((e) => keep(e.org))
      : orgs.filter(keep).map((org) => ({ org, level: 0, last: false, continues: [] }));
  const used = maxOrgs > 0 ? Math.min(totalOrgs / maxOrgs, 1) : 0;
  const filterLabel = (f: OrgFilter) => t(`orgs.tile.${f}.label`);

  return (
    <>
      <section className="bd-card bd-shadow overflow-hidden">
        <div className="flex flex-wrap items-center gap-3.5 px-[22px] py-5">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-[11px] bg-(--bd-primary-50) text-(--bd-primary-600)">
            <Globe size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="truncate font-display text-[17px] font-extrabold text-ink-900">
              {rootName}
            </div>
            <div className="text-[12.5px] text-ink-500">{t('orgs.network_note')}</div>
          </div>
          <div className="flex w-full min-w-[180px] flex-col gap-1.5 sm:ml-auto sm:w-auto">
            <div className="flex justify-between gap-4 text-[12.5px] text-ink-500">
              <span>{t('orgs.capacity')}</span>
              <span>
                <b className="text-ink-900">{totalOrgs}</b> / {maxOrgs}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={t('orgs.capacity')}
              aria-valuemin={0}
              aria-valuemax={maxOrgs}
              aria-valuenow={totalOrgs}
              className="h-1.5 overflow-hidden rounded-full bg-(--bd-border-soft)"
            >
              <div
                className={used >= NEAR_LIMIT ? 'h-full bg-amber-500' : 'h-full bg-(--bd-primary)'}
                style={{ width: `${used * 100}%` }}
              />
            </div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {ORG_FILTERS.map((f) => {
          const { icon: Icon, tone } = FILTER_TILE[f];
          const n = counts[f];
          return (
            <CountTile
              key={f}
              icon={<Icon size={20} strokeWidth={2} />}
              tone={tone}
              label={filterLabel(f)}
              count={more ? `${n}+` : String(n)}
              sub={
                f === 'pending' && n === 0 ? t('orgs.tile.pending.none') : t(`orgs.tile.${f}.sub`)
              }
              muted={f === 'pending' && n === 0}
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
            {t('orgs.network')}
            <span className="rounded-full bg-(--bd-border-soft) px-2 text-[12px] font-bold text-ink-500">
              {rows.length}
            </span>
          </h2>
          {filter === 'all' ? null : (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-(--bd-primary-50) pr-1.5 pl-2.5 text-[12.5px] font-semibold text-(--bd-primary-600)">
              {filterLabel(filter)}
              <button
                type="button"
                onClick={() => setFilter('all')}
                aria-label={t('orgs.clear_filter')}
                className="grid h-5 w-5 place-items-center rounded-full hover:bg-(--bd-card)"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          )}
          <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
            <label className="flex h-9 w-full items-center gap-2 rounded-[10px] border border-(--bd-border) bg-(--bd-bg) px-3 text-ink-500 focus-within:border-(--bd-primary) focus-within:bg-(--bd-card) focus-within:shadow-[0_0_0_3px_var(--bd-primary-50)] sm:w-[260px]">
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
            <div
              role="group"
              aria-label={t('orgs.view_label')}
              className="flex gap-0.5 rounded-[10px] bg-(--bd-border-soft) p-[3px]"
            >
              {(
                [
                  { id: 'tree', label: t('orgs.view_tree'), icon: GitBranch },
                  { id: 'list', label: t('orgs.view_list'), icon: List },
                ] as const
              ).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={view === id}
                  onClick={() => setView(id)}
                  className={cn(
                    'flex h-[30px] items-center gap-1.5 rounded-[7px] px-3 text-[12.5px] font-semibold text-ink-500',
                    view === id && 'bg-(--bd-card) text-ink-900 shadow-sm',
                  )}
                >
                  <Icon size={14} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </header>

        <div
          className={cn(
            COLS,
            'border-b border-(--bd-border-soft) bg-(--bd-bg) px-[18px] py-2.5 text-[11px] font-bold tracking-[0.1em] text-ink-500 uppercase',
          )}
        >
          <span>{t('orgs.col_name')}</span>
          <span className="hidden lg:block">{t('orgs.col_known_as')}</span>
          <span>{t('orgs.col_counts')}</span>
          <span className="hidden lg:block">{t('orgs.col_children')}</span>
          <span>
            <span className="sr-only">{t('orgs.col_view')}</span>
          </span>
        </div>

        <div className="max-h-[min(640px,70vh)] overflow-auto overscroll-contain">
          {view === 'tree' ? <RootRow name={rootName} orgs={orgs} /> : null}
          {rows.length === 0 ? (
            <p className="px-[18px] py-10 text-center text-ink-500">
              {filter === 'pending' && !q ? t('orgs.empty_pending') : t('orgs.empty')}
            </p>
          ) : (
            rows.map(({ org, level, last, continues }) => (
              <OrgRowLink
                key={org.id}
                org={org}
                level={view === 'tree' ? level + 1 : 0}
                guide={lines ? { last, continues } : null}
              />
            ))
          )}
        </div>
        {more ? (
          <p className="border-t border-(--bd-border-soft) px-[18px] py-3 text-[12.5px] text-ink-500">
            {t('org.children_more')}
          </p>
        ) : null}
      </section>
    </>
  );
}

/** The network itself, at the top of the tree. */
function RootRow({ name, orgs }: Readonly<{ name: string; orgs: OrgRow[] }>) {
  const t = useTranslations('console');
  const coordinators = orgs.reduce((n, o) => n + o.coordinator_count, 0);
  const pending = orgs.reduce((n, o) => n + o.pending_count, 0);
  return (
    <div
      className={cn(COLS, 'border-b border-(--bd-border-soft) bg-(--bd-primary-50) px-[18px] py-3')}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-(--bd-primary) text-white">
          <I.briefcase size={16} />
        </span>
        <div className="min-w-0">
          <div className="truncate font-bold text-ink-900">{name}</div>
          <div className="text-[12px] text-ink-500">{t('orgs.network_tag')}</div>
        </div>
      </div>
      <span className="hidden justify-self-start rounded-[7px] bg-(--bd-card) px-2 py-0.5 text-[12px] font-semibold text-ink-700 lg:inline">
        {t('orgs.network_known_as')}
      </span>
      <Coordinators count={coordinators} pending={pending} />
      <span className="hidden text-[13.5px] text-ink-700 lg:block">{orgs.length}</span>
      <span />
    </div>
  );
}

/** Indent per tree level, in pixels; each level's line runs under its parent's icon. */
const STEP = 46;
/** Where the first level's line runs: the centre of the network's icon. */
const LINE_X = 35;

/** The tree lines for one row: ancestors' lines that continue, and its own elbow. */
function TreeGuide({
  level,
  last,
  continues,
}: Readonly<{ level: number; last: boolean; continues: boolean[] }>) {
  const lineClass = 'pointer-events-none absolute w-0 border-l-[1.5px] border-(--bd-border)';
  return (
    <>
      {continues.map((on, i) =>
        on ? (
          <span
            key={i}
            aria-hidden="true"
            className={`${lineClass} inset-y-0`}
            style={{ left: `${LINE_X + i * STEP}px` }}
          />
        ) : null,
      )}
      <span
        aria-hidden="true"
        className={`${lineClass} top-0 ${last ? 'h-1/2' : 'bottom-0'}`}
        style={{ left: `${LINE_X + (level - 1) * STEP}px` }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 h-0 w-5 border-t-[1.5px] border-(--bd-border)"
        style={{ left: `${LINE_X + (level - 1) * STEP}px` }}
      />
    </>
  );
}

/** One organisation, opening its page; indented by its level in the tree. */
function OrgRowLink({
  org,
  level,
  guide,
}: Readonly<{
  org: OrgRow;
  level: number;
  /** Tree lines to draw, or null for none. */
  guide: { last: boolean; continues: boolean[] } | null;
}>) {
  const t = useTranslations('console');
  const knownAs = org.known_as_name ?? org.known_as;
  return (
    <Link
      href={`/console/orgs/${org.id}`}
      className={cn(
        COLS,
        'group relative border-b border-(--bd-border-soft) px-[18px] py-3 text-inherit no-underline last:border-b-0 hover:bg-(--bd-bg) hover:no-underline',
      )}
    >
      {guide && level > 0 ? (
        <TreeGuide level={level} last={guide.last} continues={guide.continues} />
      ) : null}
      <div
        className="flex min-w-0 items-center gap-3"
        style={level > 0 ? { paddingLeft: `${level * STEP}px` } : undefined}
      >
        <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-(--bd-primary-50) text-(--bd-primary-600)">
          <I.briefcase size={16} />
        </span>
        <div className="min-w-0">
          <div className="truncate font-bold text-ink-900">{org.name}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-500">
            {level === 0 && org.parent_name ? (
              <span>{t('org.under', { parent: org.parent_name })} ·</span>
            ) : null}
            <ConsoleStatusPill status={org.status} />
          </div>
        </div>
      </div>
      <span className="hidden justify-self-start rounded-[7px] bg-(--bd-border-soft) px-2 py-0.5 text-[12px] font-semibold text-ink-700 lg:inline">
        {knownAs ?? '—'}
      </span>
      <Coordinators count={org.coordinator_count} pending={org.pending_count} />
      <span
        className={cn(
          'hidden text-[13.5px] lg:block',
          org.child_count ? 'text-ink-700' : 'text-ink-400',
        )}
      >
        {org.child_count || t('orgs.none')}
      </span>
      <span className="flex items-center gap-1 justify-self-end rounded-lg px-2 py-1.5 text-[13px] font-semibold text-(--bd-primary-600) group-hover:bg-(--bd-primary-50)">
        {t('orgs.open')}
        <ArrowRight size={14} aria-hidden="true" />
      </span>
    </Link>
  );
}

/** A coordinator count with the number waiting for review. */
function Coordinators({ count, pending }: Readonly<{ count: number; pending: number }>) {
  const t = useTranslations('console');
  return (
    <span className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink-900">
      {count}
      {pending > 0 ? (
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11.5px] font-bold text-amber-700">
          {t('home.pending', { count: pending })}
        </span>
      ) : null}
    </span>
  );
}
