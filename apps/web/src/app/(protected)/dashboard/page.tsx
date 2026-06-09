'use client';

import { useEffect, useState, useRef, useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations, useLocale } from 'next-intl';
import { Button } from '../../../components/ui/Button';
import { StatusPill } from '../../../components/ui/StatusPill';
import { Avatar } from '../../../components/ui/Avatar';
import { SegmentedTabs, type SegmentedTab } from '../../../components/ui/SegmentedTabs';
import { Topbar } from '../../../components/shell/Topbar';
import { LifecyclePill } from '../../../components/LifecyclePill';
import { CompletionBar } from '../../../components/CompletionBar';
import { I, type IconName } from '../../../icons';
import { useOppProviders, useDashboard, useDashboardItems } from '../../../hooks/useDashboard';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';
import {
  dashboardService,
  triggerCsvDownload,
  type LifecycleFilter,
} from '../../../services/dashboard.service';
import { useProfileRaw } from '../../../hooks/useProfile';
import { useThemeMode } from '../../../lib/theme-mode';
import type {
  LifecycleStatus,
  ParticipantBase,
  ParticipantStatus,
  Provider,
  Seeker,
} from '../../../types';

type Tab = 'seekers' | 'providers' | 'opp';

/**
 * Indexes a domain's `status_rules` by status key so the dashboard can
 * pull per-status label/description copy onto the status cards.
 *
 * @param rules - The active domain's `status_rules` from network config.
 * @returns Map of status key to its optional label/description copy.
 */
function indexStatusRules(
  rules: { status: string; label?: string; description?: string }[] | undefined,
): Record<string, { label?: string; description?: string }> {
  const out: Record<string, { label?: string; description?: string }> = {};
  for (const r of rules ?? []) {
    out[r.status] = {
      ...(r.label !== undefined ? { label: r.label } : {}),
      ...(r.description !== undefined ? { description: r.description } : {}),
    };
  }
  return out;
}

type StatTone = 'new' | 'active' | 'risk' | 'inactive' | 'satisfied';

interface ToneConfig {
  ring: string;
  bg: string;
  icon: string;
  num: string;
}

interface ToneNumColors {
  light: string;
  dark: string;
}
type StatToneConfig = Omit<ToneConfig, 'num'> & { num: ToneNumColors };

const STAT_TONES: Record<StatTone, StatToneConfig> = {
  new: {
    ring: '#6EE7B7',
    bg: 'linear-gradient(180deg,var(--bd-tint-emerald) 0%,var(--bd-card) 70%)',
    icon: '#059669',
    num: { light: '#065F46', dark: '#6EE7B7' },
  },
  active: {
    ring: '#A7F3D0',
    bg: 'linear-gradient(180deg,var(--bd-tint-emerald) 0%,var(--bd-card) 70%)',
    icon: '#10B981',
    num: { light: '#047857', dark: '#34D399' },
  },
  risk: {
    ring: '#FCD34D',
    bg: 'linear-gradient(180deg,var(--bd-tint-amber) 0%,var(--bd-card) 70%)',
    icon: '#F59E0B',
    num: { light: '#B45309', dark: '#FBBF24' },
  },
  inactive: {
    ring: '#FCA5A5',
    bg: 'linear-gradient(180deg,var(--bd-tint-rose) 0%,var(--bd-card) 70%)',
    icon: '#EF4444',
    num: { light: '#B91C1C', dark: '#F87171' },
  },
  satisfied: {
    ring: '#C7D2FE',
    bg: 'linear-gradient(180deg,var(--bd-tint-primary) 0%,var(--bd-card) 70%)',
    icon: '#6366F1',
    num: { light: '#4338CA', dark: '#A5B4FC' },
  },
};

interface StatCardProps {
  tone: StatTone;
  count: string;
  label: string;
  icon: IconName;
  hint?: string;
  action?: ReactNode;
}

function StatCard({ tone, count, label, icon, hint, action }: StatCardProps) {
  const t = STAT_TONES[tone] ?? STAT_TONES.inactive;
  const { mode } = useThemeMode();
  const Ic = I[icon];
  const numColor = mode === 'dark' ? t.num.dark : t.num.light;
  return (
    <div
      className="bd-card bd-shadow p-5 flex flex-col gap-3 relative overflow-hidden"
      style={{ background: t.bg }}
    >
      <div className="flex items-start justify-between">
        <div
          className="w-9 h-9 rounded-[10px] flex items-center justify-center"
          style={{ background: 'var(--bd-card)', border: `1px solid ${t.ring}`, color: t.icon }}
        >
          <Ic size={18} />
        </div>
        {action}
      </div>
      <div>
        <div
          className="font-display font-bold text-[28px] leading-none tracking-tight"
          style={{ color: numColor }}
        >
          {count}
        </div>
        <div className="text-[13px] text-ink-500 mt-1.5 font-medium">{label}</div>
        {hint && <div className="text-[11.5px] text-ink-400 mt-0.5">{hint}</div>}
      </div>
    </div>
  );
}

type DeltaTone = 'up' | 'down' | 'flat';

interface MiniStatProps {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: DeltaTone;
}

const DELTA_TONES: Record<DeltaTone, string> = {
  up: 'text-emerald-600 bg-emerald-50',
  down: 'text-rose-600 bg-rose-50',
  flat: 'text-ink-500 bg-ink-100',
};

function MiniStat({ label, value, delta, deltaTone = 'flat' }: MiniStatProps) {
  return (
    <div className="bd-card p-4 flex flex-col gap-1.5">
      <div className="text-[12px] text-ink-400 font-medium">{label}</div>
      <div className="flex items-baseline gap-2">
        <div className="font-display font-bold text-[22px] text-ink-900 leading-none tracking-tight">
          {value}
        </div>
        {delta && (
          <span
            className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-md ${DELTA_TONES[deltaTone]}`}
          >
            {delta}
          </span>
        )}
      </div>
    </div>
  );
}

interface FunnelPart {
  v: number;
  color: string;
  label: string;
  short: string;
}

interface FunnelCellProps {
  total: number;
  parts: FunnelPart[];
}

function FunnelCell({ total, parts }: FunnelCellProps) {
  const sum = parts.reduce((a, b) => a + b.v, 0) || 1;
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement | null>(null);

  const onEnter = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: r.left + window.scrollX, y: r.bottom + window.scrollY + 8 });
    setHover(true);
  };

  return (
    <>
      <div
        ref={ref}
        onMouseEnter={onEnter}
        onMouseLeave={() => setHover(false)}
        className="inline-flex items-center gap-2 cursor-default"
      >
        <span className="font-display font-bold text-[18px] text-ink-900 tabular-nums leading-none">
          {total}
        </span>
        <div className="flex h-1 w-16 rounded-full overflow-hidden bg-ink-100">
          {parts.map((p, i) => (
            <div key={i} style={{ width: `${(p.v / sum) * 100}%`, background: p.color }} />
          ))}
        </div>
      </div>

      {hover &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{ position: 'absolute', left: pos.x, top: pos.y, zIndex: 9999 }}
            className="bg-white border border-[var(--bd-border)] rounded-[10px] bd-shadow-lg p-2.5 min-w-[160px] pointer-events-none animate-[fadeUp_.12s_ease-out]"
          >
            <div className="flex flex-col gap-1.5">
              {parts.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-[12px]">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
                  <span className="text-ink-500 flex-1">{p.label}</span>
                  <span className="font-semibold tabular-nums text-ink-900">{p.v}</span>
                </div>
              ))}
              <div className="border-t border-[var(--bd-border-soft)] mt-1 pt-1.5 flex items-center gap-2 text-[12px]">
                <span className="text-ink-400 flex-1">Total</span>
                <span className="font-display font-bold tabular-nums text-ink-900">{total}</span>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function ProgressTiny({ pct }: { pct: number }) {
  const color = pct >= 80 ? '#10B981' : pct >= 50 ? '#F59E0B' : '#EF4444';
  const label = pct >= 80 ? 'Complete' : 'Incomplete';
  return (
    <div className="flex items-center gap-2" title={`${label} · ${pct}%`}>
      <div className="w-14 h-1.5 rounded-full bg-ink-100 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[11px] tabular-nums text-ink-500 font-medium">{pct}%</span>
    </div>
  );
}

type RowKind = 'seeker' | 'provider' | 'opp';

type ChipTone = 'soft' | 'warm' | 'cool' | 'mute';

const CHIP_TONES: Record<ChipTone, string> = {
  soft: 'bg-[var(--bd-primary-50)] text-primary-600 hover:bg-[var(--bd-primary-100)]',
  warm: 'bg-amber-50 text-amber-800 hover:bg-amber-100',
  cool: 'bg-sky-50 text-sky-800 hover:bg-sky-100',
  mute: 'bg-ink-100 text-ink-600 hover:bg-ink-200',
};

interface RecommendedAction {
  label: string;
  tone: ChipTone;
  icon: ReactNode;
}

/**
 * Turns a signalstack `actionable_tags` entry into a chip. Tags follow
 * the `missing_<required_field>` shape (e.g. `missing_contact_phone`),
 * which we surface as "Add Contact Phone". Unknown tag shapes are
 * title-cased verbatim so new server-side tags still render readably.
 */
function tagToAction(tag: string): RecommendedAction {
  if (tag.startsWith('missing_')) {
    const field = tag
      .slice('missing_'.length)
      .split('_')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    return { label: `Add ${field}`, tone: 'warm', icon: <I.alert size={12} /> };
  }
  const label = tag
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return { label, tone: 'cool', icon: <I.spark size={12} /> };
}

/**
 * Recommended-action chips for a row. Prefers signalstack's
 * server-computed `actionableTags`; when none are present, falls back
 * to a small client-side heuristic on status + profile completeness so
 * the column is never empty.
 */
function recommendedActions(row: ParticipantBase, kind: RowKind): RecommendedAction[] {
  const tags = row.actionableTags ?? [];
  if (tags.length > 0) {
    return tags.slice(0, 2).map(tagToAction);
  }
  const out: RecommendedAction[] = [];
  if (row.status === 'at-risk')
    out.push({ label: 'Re-engage', tone: 'warm', icon: <I.send size={12} /> });
  if (row.status === 'inactive')
    out.push({ label: 'Send nudge', tone: 'mute', icon: <I.bell size={12} /> });
  if (!row.profile.verified)
    out.push({ label: 'Verify', tone: 'cool', icon: <I.shield size={12} /> });
  if (row.profile.complete < 70)
    out.push({ label: 'Complete profile', tone: 'soft', icon: <I.spark size={12} /> });
  if (kind === 'provider' && row.status === 'active')
    out.push({ label: 'Suggest match', tone: 'soft', icon: <I.trending size={12} /> });
  if (kind === 'seeker' && (row.applied.shortlisted ?? 0) >= 5)
    out.push({ label: 'Coach interview', tone: 'soft', icon: <I.message size={12} /> });
  if (out.length === 0)
    out.push({ label: 'View profile', tone: 'mute', icon: <I.external size={12} /> });
  return out.slice(0, 2);
}

function ActionChip({
  label,
  tone = 'soft',
  icon,
}: {
  label: string;
  tone?: ChipTone;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-semibold transition-colors ${CHIP_TONES[tone]}`}
    >
      {icon}
      {label}
    </button>
  );
}

type StatusFilter = string; // 'all' | any key signalstack returns in rollup.by_status

/**
 * Lifecycle dropdown values. `'all'` is the no-filter sentinel; the other
 * four map 1:1 to {@link LifecycleFilter} on the items endpoint.
 */
type LifecycleFilterValue = 'all' | LifecycleFilter;

const LIFECYCLE_FILTER_VALUES: LifecycleFilterValue[] = [
  'all',
  'draft',
  'live',
  'paused',
  'account_only',
];

/**
 * Parse `?lifecycle=` from a search-params bag, validating against the
 * known enum. Unknown values resolve to `'all'` so a stale URL does not
 * blank the filter dropdown.
 */
function parseLifecycleParam(raw: string | null): LifecycleFilterValue {
  if (!raw) return 'all';
  return (LIFECYCLE_FILTER_VALUES as readonly string[]).includes(raw)
    ? (raw as LifecycleFilterValue)
    : 'all';
}

interface StatusOption {
  value: StatusFilter;
  label: string;
  count?: number;
}

/**
 * Render a snake_case / kebab-case signalstack status key as a Title-Case
 * label. Avoids hardcoding the status taxonomy — signalstack's by_status
 * is an open map, so new statuses surface automatically.
 */
function statusLabel(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length ? w[0]!.toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function buildStatusOptions(
  byStatus: Record<string, number> | undefined,
  allLabel: string,
): StatusOption[] {
  const opts: StatusOption[] = [{ value: 'all', label: allLabel }];
  if (!byStatus) return opts;
  for (const [key, count] of Object.entries(byStatus)) {
    if (!key) continue;
    opts.push({ value: key, label: statusLabel(key), count });
  }
  return opts;
}

/**
 * Looks up a bucket label from the config-sourced map, falling back to
 * an optional translated fallback supplier, then the raw key. Always returns a string.
 *
 * @param labels - Config-sourced bucket label map (may be from `dashboardBuckets.by_action_status`).
 * @param key - Bucket key (e.g. `'create'`, `'accept'`).
 * @param getFallback - Optional function that returns the localised fallback label for the key.
 * @returns The resolved label string.
 */
function getBucketLabel(
  labels: Record<string, string>,
  key: string,
  getFallback?: (k: string) => string,
): string {
  return labels[key] ?? getFallback?.(key) ?? key;
}

interface ParticipantTableProps<R extends ParticipantBase> {
  kind: RowKind;
  rows: R[];
  /**
   * Total count from signalstack `total_matching` — required to compute
   * the page list and decide whether to render the pagination footer.
   * When equal to `rows.length` (single page), the page buttons are
   * suppressed; the "Showing 1–N of N" line stays.
   */
  total?: number | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
  onPageChange?: ((next: number) => void) | undefined;
  /**
   * Server-side status filter. `'all'` means no `?status=` is sent to
   * signalstack. Other values map 1:1 to signalstack's status taxonomy.
   */
  statusFilter?: StatusFilter | undefined;
  onStatusFilterChange?: ((next: StatusFilter) => void) | undefined;
  /**
   * Statuses available for this domain, derived from
   * `rollup.by_status` so the popover always reflects what signalstack
   * actually has for this aggregator.
   */
  statusOptions?: StatusOption[] | undefined;
  /**
   * Action-status bucket labels sourced from `dashboardBuckets.by_action_status`
   * in the aggregator config. Falls back to localised `t('buckets.*')` when absent.
   */
  bucketLabels?: Record<string, string> | undefined;
  /**
   * Active lifecycle dropdown value. `'all'` hides the URL param.
   */
  lifecycleFilter?: LifecycleFilterValue | undefined;
  onLifecycleFilterChange?: ((next: LifecycleFilterValue) => void) | undefined;
}

function ParticipantTable<R extends ParticipantBase>({
  kind,
  rows,
  total,
  page = 1,
  pageSize = 25,
  onPageChange,
  statusFilter = 'all',
  onStatusFilterChange,
  statusOptions,
  bucketLabels = {},
  lifecycleFilter = 'all',
  onLifecycleFilterChange,
}: ParticipantTableProps<R>) {
  const t = useTranslations('dashboard');
  /** Localised fallback for bucket keys when config-sourced labels are absent. */
  const getBucketFallback = (key: string): string => {
    const map: Record<string, string> = {
      create: t('buckets.created'),
      accept: t('buckets.accepted'),
      reject: t('buckets.rejected'),
      cancel: t('buckets.cancelled'),
    };
    return map[key] ?? key;
  };
  const options: StatusOption[] = statusOptions ?? [
    { value: 'all', label: t('filters.all_statuses') },
  ];
  const searchId = `bd-search-${kind}`;
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);

  // Close the filter popover on outside click. Tracks `mousedown` so the
  // close fires before any button inside the popover would re-toggle it.
  useEffect(() => {
    if (!filterOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [filterOpen]);

  // Client-side search across the fields the table renders. The dashboard
  // endpoint has no free-text query param, so search filters the visible
  // page only — clearing it restores the full server-paginated view.
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [r.name, r.id, r.city, (r as unknown as Provider).role ?? '']
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query]);

  const filterActive = statusFilter !== 'all';

  // Map UI kind onto the signalstack domain. `opp` rides on the provider
  // dataset until signalstack exposes a dedicated opportunity-provider
  // endpoint (mirrors the read path in dashboardService).
  const exportDomain: 'seeker' | 'provider' = kind === 'seeker' ? 'seeker' : 'provider';

  const onExportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const result = await dashboardService.dashboardExport({ domain: exportDomain });
      triggerCsvDownload(result);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="bd-card bd-shadow overflow-hidden">
      <div className="px-5 py-4 flex items-center gap-3 border-b border-[var(--bd-border)]">
        <div className="font-display font-bold text-[15px] text-ink-900">
          {kind === 'seeker'
            ? t('table.participants')
            : kind === 'opp'
              ? t('table.opportunityProviders')
              : t('tabs.providers')}
        </div>
        <span className="text-[12px] text-ink-400">
          {t('table.count', { shown: visibleRows.length, total: total ?? rows.length })}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <label htmlFor={searchId} className="sr-only">
              {t('aria.search_participants')}
            </label>
            <I.search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
            />
            <input
              id={searchId}
              aria-label={t('aria.search_participants')}
              className="bd-input w-[320px] text-[13px] py-1.5"
              style={{ paddingLeft: 36 }}
              placeholder={
                kind === 'seeker' ? t('search.seekerPlaceholder') : t('search.providerPlaceholder')
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {onLifecycleFilterChange ? (
            <label className="flex items-center gap-2 text-[12px] text-ink-500">
              <span className="font-medium">{t('filters.lifecycle_label')}</span>
              <select
                aria-label={t('filters.lifecycle_label')}
                className="bd-input text-[12.5px] py-1.5 pr-7"
                value={lifecycleFilter}
                onChange={(e) => onLifecycleFilterChange(e.target.value as LifecycleFilterValue)}
              >
                <option value="all">{t('filters.lifecycle_all')}</option>
                <option value="draft">{t('filters.lifecycle_draft')}</option>
                <option value="live">{t('filters.lifecycle_live')}</option>
                <option value="paused">{t('filters.lifecycle_paused')}</option>
                <option value="account_only">{t('filters.lifecycle_account_only')}</option>
              </select>
            </label>
          ) : null}
          <div ref={filterRef} className="relative">
            <Button
              kind={filterActive ? 'primary' : 'ghost'}
              icon={<I.filter size={14} />}
              onClick={() => setFilterOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={filterOpen}
            >
              {filterActive
                ? (options.find((o) => o.value === statusFilter)?.label ?? 'Filtered')
                : 'All filters'}
            </Button>
            {filterOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-1 z-20 min-w-[180px] bg-white border border-[var(--bd-border)] rounded-[10px] bd-shadow-lg p-1"
              >
                {options.map((opt) => {
                  const active = statusFilter === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => {
                        onStatusFilterChange?.(opt.value);
                        setFilterOpen(false);
                      }}
                      className={`w-full text-left px-2.5 py-1.5 rounded-md text-[12.5px] flex items-center justify-between ${
                        active
                          ? 'bg-[var(--bd-primary-50)] text-primary-600 font-semibold'
                          : 'text-ink-700 hover:bg-ink-50'
                      }`}
                    >
                      <span>{opt.label}</span>
                      {opt.count !== undefined ? (
                        <span className="text-[11px] tabular-nums text-ink-400">{opt.count}</span>
                      ) : active ? (
                        <I.check size={12} />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <Button
            kind="ghost"
            icon={<I.download size={14} />}
            onClick={onExportCsv}
            disabled={exporting}
            title={exportError ?? t('aria.export_csv')}
            aria-label={t('aria.export_csv')}
          >
            {exporting ? t('buttons.exporting') : t('buttons.exportCsv')}
          </Button>
        </div>
      </div>

      <div className="overflow-auto scroll-x" style={{ maxHeight: 520 }}>
        <table className="bd-table" style={{ minWidth: kind === 'provider' ? 1380 : 1280 }}>
          <thead
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 4,
              background: 'var(--bd-table-head-bg)',
            }}
          >
            <tr>
              <th
                style={{
                  position: 'sticky',
                  left: 0,
                  zIndex: 5,
                  background: 'var(--bd-table-head-bg)',
                  minWidth: 240,
                }}
              >
                {kind === 'seeker' ? t('table.participant') : t('table.provider')}
              </th>
              <th>{t('table.joined')}</th>
              <th>{t('table.profileStatus')}</th>
              <th>{t('table.lifecycle')}</th>
              <th>{bucketLabels['create'] ?? t('table.applied')}</th>
              <th>{t('table.status')}</th>
              <th>{t('table.recommendedAction')}</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => {
              return (
                <tr key={r.id} className="fade-up">
                  <td
                    style={{
                      position: 'sticky',
                      left: 0,
                      background: 'inherit',
                      backgroundColor: 'var(--bd-card)',
                      zIndex: 1,
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <Avatar initials={r.avatar} />
                      <div className="min-w-0">
                        <div className="font-semibold text-ink-900 text-[14px] truncate flex items-center gap-1.5">
                          {r.name}
                          {r.profile.verified && (
                            <I.shield size={13} className="text-emerald-500" />
                          )}
                        </div>
                        <div className="text-[12px] text-ink-400 flex items-center gap-1.5 mt-0.5">
                          <span className="font-mono">{r.id}</span>
                          <span className="text-ink-200">·</span>
                          <span>{r.city}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="text-[13px] text-ink-700">{r.joined}</div>
                    <div className="text-[11px] text-ink-400 mt-0.5">last seen {r.last}</div>
                  </td>
                  <td>
                    <ProgressTiny pct={r.profile.complete} />
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <LifecyclePill status={r.lifecycle_status ?? null} />
                      {r.lifecycle_status === 'draft' && typeof r.completion_pct === 'number' ? (
                        <CompletionBar percent={r.completion_pct} />
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <FunnelCell
                      total={r.applied.total}
                      parts={[
                        {
                          v: r.applied.pending,
                          color: 'var(--bd-funnel-requested)',
                          label: getBucketLabel(bucketLabels, 'create', getBucketFallback),
                          short: getBucketLabel(bucketLabels, 'create', getBucketFallback),
                        },
                        {
                          v: r.applied.accepted ?? 0,
                          color: 'var(--bd-funnel-connected)',
                          label: getBucketLabel(bucketLabels, 'accept', getBucketFallback),
                          short: getBucketLabel(bucketLabels, 'accept', getBucketFallback),
                        },
                        {
                          v: r.applied.rejected,
                          color: 'var(--bd-funnel-declined)',
                          label: getBucketLabel(bucketLabels, 'reject', getBucketFallback),
                          short: getBucketLabel(bucketLabels, 'reject', getBucketFallback),
                        },
                        {
                          v: r.applied.cancelled ?? 0,
                          color: 'var(--bd-funnel-cancelled)',
                          label: getBucketLabel(bucketLabels, 'cancel', getBucketFallback),
                          short: getBucketLabel(bucketLabels, 'cancel', getBucketFallback),
                        },
                      ]}
                    />
                  </td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                  <td>
                    <div className="flex items-center gap-1.5">
                      {recommendedActions(r, kind).map((a, i) => (
                        <ActionChip key={i} {...a} />
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <PaginationFooter
        page={page}
        pageSize={pageSize}
        total={total ?? rows.length}
        rowsOnPage={rows.length}
        onPageChange={onPageChange}
        searchActive={query.trim().length > 0}
        visibleCount={visibleRows.length}
      />
    </div>
  );
}

interface PaginationFooterProps {
  page: number;
  pageSize: number;
  total: number;
  rowsOnPage: number;
  onPageChange?: ((next: number) => void) | undefined;
  /**
   * Search filtering happens client-side on the current page, so when a
   * search is active the page count is meaningless — hide the buttons
   * and reflect the filtered count in the "Showing" line instead.
   */
  searchActive?: boolean | undefined;
  visibleCount?: number | undefined;
}

/**
 * Table footer. Always renders the "Showing X–Y of Z" line. Page buttons
 * are rendered only when more than one page exists — single-page tables
 * skip the numbered list entirely so a 5-row dashboard doesn't show
 * dead "2" / "3" controls.
 */
function PaginationFooter({
  page,
  pageSize,
  total,
  rowsOnPage,
  onPageChange,
  searchActive = false,
  visibleCount,
}: PaginationFooterProps) {
  const t = useTranslations('dashboard');
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = (page - 1) * pageSize + rowsOnPage;
  const canPrev = page > 1;
  const canNext = page < totalPages;
  // When a search query is active, the visible row count is filtered
  // from the current page only — show that, not the unfiltered range,
  // so the count line matches what the user sees in the table body.
  const showSearchSummary = searchActive && visibleCount !== undefined;
  const change = (next: number) => {
    if (!onPageChange) return;
    if (next < 1 || next > totalPages || next === page) return;
    onPageChange(next);
  };
  // Numbered list capped at 7 entries with leading/trailing ellipsis
  // so dashboards with many pages stay readable.
  const pageList = buildPageList(page, totalPages);
  return (
    <div className="px-5 py-3 border-t border-[var(--bd-border)] flex items-center justify-between text-[12.5px] text-ink-500">
      <div>
        {showSearchSummary
          ? t('pagination.matching', { shown: visibleCount, rowsOnPage })
          : t('pagination.showing', { from: start, to: end, total })}
      </div>
      {totalPages > 1 && !searchActive && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t('aria.prev_page')}
            disabled={!canPrev}
            onClick={() => change(page - 1)}
            className="px-2.5 py-1.5 rounded-md hover:bg-ink-100 text-ink-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <I.chevL size={14} />
          </button>
          {pageList.map((p, i) =>
            p === '…' ? (
              <span key={`gap-${i}`} className="px-2 text-ink-300 select-none">
                …
              </span>
            ) : p === page ? (
              <button
                key={p}
                type="button"
                aria-current="page"
                className="px-3 py-1 rounded-md bg-[var(--bd-primary-50)] text-primary-600 font-semibold"
              >
                {p}
              </button>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => change(p)}
                className="px-3 py-1 rounded-md hover:bg-ink-100"
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button"
            aria-label={t('aria.next_page')}
            disabled={!canNext}
            onClick={() => change(page + 1)}
            className="px-2.5 py-1.5 rounded-md hover:bg-ink-100 text-ink-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <I.chevR size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Returns the numbered button list with ellipsis markers. For ≤ 7 pages
 * we render every number. Beyond that, we surround the current page with
 * one neighbour on each side and pin the first / last pages, dropping
 * the gaps with `…`.
 */
function buildPageList(current: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const out: Array<number | '…'> = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(totalPages - 1, current + 1);
  if (left > 2) out.push('…');
  for (let p = left; p <= right; p++) out.push(p);
  if (right < totalPages - 1) out.push('…');
  out.push(totalPages);
  return out;
}

function LoadingCard() {
  const t = useTranslations('dashboard');
  return (
    <div className="bd-card bd-shadow p-8 text-[13px] text-ink-400" style={{ opacity: 0.6 }}>
      {t('state.loading')}
    </div>
  );
}

function ErrorCard() {
  const t = useTranslations('dashboard');
  return (
    <div className="bd-card bd-shadow p-8 text-[13px] text-rose-600">{t('state.failedToLoad')}</div>
  );
}

const PAGE_SIZE = 25;

/**
 * URL-backed lifecycle filter state. Reads `?lifecycle=` on every render
 * via `useSearchParams` and updates the URL through `router.replace` (so
 * the filter participates in browser history but doesn't push a new
 * navigation entry per click).
 *
 * Returns the parsed value + a setter that mirrors changes back to the
 * URL. `'all'` removes the param entirely so default views read clean.
 */
function useLifecycleUrlFilter(): [LifecycleFilterValue, (next: LifecycleFilterValue) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = parseLifecycleParam(searchParams.get('lifecycle'));
  const setValue = (next: LifecycleFilterValue) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'all') params.delete('lifecycle');
    else params.set('lifecycle', next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return [value, setValue];
}

/**
 * Builds a lookup keyed by signalstack `item_id` so per-row lifecycle
 * data from `/v1/dashboard/items` can be merged into the rollup rows the
 * participant table renders. Empty map when items haven't loaded yet.
 */
function buildLifecycleByItemId(
  items: Array<Record<string, unknown>> | undefined,
): Map<string, { lifecycle_status: LifecycleStatus; completion_pct: number | null }> {
  const out = new Map<
    string,
    { lifecycle_status: LifecycleStatus; completion_pct: number | null }
  >();
  if (!items) return out;
  for (const it of items) {
    const id = typeof it.item_id === 'string' ? it.item_id : null;
    if (!id) continue;
    const ls = it.lifecycle_status;
    const lifecycle_status: LifecycleStatus = ls === 'draft' || ls === 'paused' ? ls : 'live';
    const completion_pct = typeof it.completion_pct === 'number' ? it.completion_pct : null;
    out.set(id, { lifecycle_status, completion_pct });
  }
  return out;
}

function SeekersTab() {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  // Signalstack's `/aggregator/dashboard` is the only endpoint that
  // correctly scopes participant lookups by the caller's signalstack org
  // (via the per-call `x-acting-org-id` header). The response now
  // wraps every served domain under `by_domain[<id>]` so seeker +
  // provider tabs share a single fetch.
  //
  // Domain id comes from the live network config so networks that
  // declare non-default ids (e.g. orange_dot's `tourist`) still resolve
  // to the right `by_domain[<id>]` slice. Falls back to 'seeker' for
  // legacy blue/purple defaults.
  const { data: cfgRaw } = useAggregatorConfig();
  // No fallback — undefined here lets useDashboard's `enabled` gate skip
  // the call until the live network config loads (prevents a stale
  // `?domain=seeker` fetch on cold mount with DEFAULT_AGGREGATOR_CONFIG).
  const seekerDomainId = cfgRaw?.domains?.[0]?.id;
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [lifecycleFilter, setLifecycleFilter] = useLifecycleUrlFilter();
  const handleStatusFilterChange = (next: StatusFilter) => {
    setPage(1);
    setStatusFilter(next);
  };
  const handleLifecycleFilterChange = (next: LifecycleFilterValue) => {
    setPage(1);
    setLifecycleFilter(next);
  };
  const filterActive = statusFilter !== 'all';
  const {
    data: dashboard,
    isLoading,
    isError,
  } = useDashboard(
    seekerDomainId
      ? {
          domain: seekerDomainId,
          page,
          limit: PAGE_SIZE,
          ...(filterActive ? { status: statusFilter } : {}),
        }
      : undefined,
  );
  // Parallel fetch for the lifecycle tile counts + per-item lifecycle
  // payload. Forwards `?lifecycle=` end-to-end (URL → fetch → API). The
  // items endpoint always returns `meta.tiles` reflecting the full
  // unfiltered dataset, regardless of the lifecycle narrowing.
  const lifecycleArg: LifecycleFilter | undefined =
    lifecycleFilter === 'all' ? undefined : lifecycleFilter;
  const { data: lifecycleItems } = useDashboardItems(
    seekerDomainId
      ? {
          domain: seekerDomainId,
          ...(lifecycleArg ? { lifecycle: lifecycleArg } : {}),
        }
      : undefined,
  );
  const lifecycleByItemId = useMemo(
    () => buildLifecycleByItemId(lifecycleItems?.items),
    [lifecycleItems?.items],
  );
  const slice = seekerDomainId ? dashboard?.by_domain[seekerDomainId] : undefined;
  const rollup = slice?.rollup;
  const { data: cfg } = useAggregatorConfig();
  const seekerCfg = cfg?.domains?.find((d) => d.id === seekerDomainId);
  const seekerTileLabels = seekerCfg?.dashboardTiles ?? {};
  const seekerPlural = seekerCfg?.plural_label ?? t('tabs.seekers');
  // by_action_status bucket labels — wired to the funnel cells in the
  // participant table's action-count columns.
  const bucketLabels = cfg?.dashboardBuckets?.by_action_status ?? {};
  const statusLabels = cfg?.dashboardBuckets?.by_status ?? {};
  const statusRules = indexStatusRules(seekerCfg?.status_rules);
  const total = rollup?.total_items;
  const byStatus = rollup?.by_status ?? {};
  // Cache the unfiltered status taxonomy the first time it loads, so the
  // dropdown stays populated when the user picks a filter that narrows
  // `by_status` down to a single key. Refreshed only on unfiltered
  // responses — keeps a single fetch per tab.
  const [cachedByStatus, setCachedByStatus] = useState<Record<string, number> | undefined>();
  useEffect(() => {
    if (!filterActive && rollup?.by_status) {
      setCachedByStatus(rollup.by_status);
    }
  }, [filterActive, rollup?.by_status]);
  const statusOptions = useMemo(
    () => buildStatusOptions(cachedByStatus ?? byStatus, t('filters.all_statuses')),
    [cachedByStatus, byStatus, t],
  );
  // Signalstack's status taxonomy is open — pick the keys the UI cares
  // about; unknown ones still surface in the items list.
  const active = byStatus['active'] ?? byStatus['new'];
  const atRisk = byStatus['at_risk'];
  const inactive = byStatus['inactive'];
  const completeProfiles = rollup?.complete_profiles;
  const hasApplications = rollup?.has_applications;
  const newThisWeek = byStatus['new'];
  const rows = useMemo(
    () => (slice?.items ?? []).map((p) => toSeekerRow(p, locale, lifecycleByItemId)),
    [slice?.items, locale, lifecycleByItemId],
  );

  // Refresh handler: hits the BFF with refresh=true to force signalstack to
  // recompute the rollup synchronously, then invalidates the React Query
  // cache so the next normal render picks up the freshly stored values.
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      if (!seekerDomainId) return;
      await dashboardService.dashboard({
        domain: seekerDomainId,
        page,
        limit: PAGE_SIZE,
        ...(filterActive ? { status: statusFilter } : {}),
        refresh: true,
      });
      await queryClient.invalidateQueries({
        queryKey: ['dashboard', 'dashboard', seekerDomainId],
      });
      setLastRefreshedAt(Date.now());
    } catch (err) {
      console.error('Dashboard refresh failed', err);
      setRefreshError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-ink-700">{seekerPlural}</span>
        <div className="flex items-center gap-2">
          <Button
            kind="ghost"
            icon={
              <I.refresh
                size={14}
                className={refreshing ? 'animate-spin' : undefined}
                aria-hidden="true"
              />
            }
            onClick={() => {
              void handleRefresh();
            }}
            disabled={refreshing}
            aria-label={t('aria.refresh')}
            title={t('aria.refresh')}
          >
            {refreshing ? t('buttons.refreshing') : t('buttons.refresh')}
          </Button>
          {refreshError ? (
            <span className="ml-2 max-w-[220px] truncate text-xs text-red-600" title={refreshError}>
              {t('state.refreshFailed')}
            </span>
          ) : lastRefreshedAt !== null && Date.now() - lastRefreshedAt < 5000 ? (
            <span className="text-xs text-ink-400">{t('state.refreshedJustNow')}</span>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          tone="new"
          icon="spark"
          count={fmtCount(byStatus['new'] ?? 0)}
          label={statusRules['new']?.label ?? statusLabels['new'] ?? t('statuses.new')}
          hint={statusRules['new']?.description ?? t('hints.new')}
        />
        <StatCard
          tone="active"
          icon="users"
          count={fmtCount(active)}
          label={
            statusRules['active']?.label ??
            statusLabels['active'] ??
            `${t('statuses.active')} ${seekerPlural}`
          }
          hint={statusRules['active']?.description ?? t('hints.active')}
        />
        <StatCard
          tone="risk"
          icon="alert"
          count={fmtCount(atRisk)}
          label={statusRules['at_risk']?.label ?? statusLabels['at_risk'] ?? t('statuses.at_risk')}
          hint={statusRules['at_risk']?.description ?? t('hints.at_risk')}
        />
        <StatCard
          tone="inactive"
          icon="pause"
          count={fmtCount(inactive)}
          label={
            statusRules['inactive']?.label ?? statusLabels['inactive'] ?? t('statuses.inactive')
          }
          hint={statusRules['inactive']?.description ?? t('hints.inactive')}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MiniStat
          label={
            seekerTileLabels.total_items ?? t('ministat.totalItems', { entityPlural: seekerPlural })
          }
          value={fmtCount(total)}
        />
        <MiniStat
          label={seekerTileLabels.complete_profiles ?? t('ministat.completeProfiles')}
          value={fmtCount(completeProfiles)}
        />
        <MiniStat
          label={
            seekerTileLabels.has_applications ??
            t('ministat.withApplications', { entityPlural: seekerPlural })
          }
          value={fmtCount(hasApplications)}
        />
        <MiniStat
          label={statusLabels['new'] ?? t('ministat.newParticipants')}
          value={fmtCount(newThisWeek)}
          delta={t('ministat.delta_this_week')}
          deltaTone="flat"
        />
      </div>

      {isLoading ? (
        <LoadingCard />
      ) : isError ? (
        <ErrorCard />
      ) : (
        <ParticipantTable
          kind="seeker"
          rows={rows}
          total={slice?.total_matching ?? total}
          page={page}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          statusFilter={statusFilter}
          onStatusFilterChange={handleStatusFilterChange}
          statusOptions={statusOptions}
          bucketLabels={bucketLabels}
          lifecycleFilter={lifecycleFilter}
          onLifecycleFilterChange={handleLifecycleFilterChange}
        />
      )}
    </div>
  );
}

/**
 * Render a numeric stat value, falling back to an em-dash when the
 * upstream rollup hasn't loaded yet or signalstack doesn't expose the
 * field.
 */
function fmtCount(n: number | null | undefined): string {
  if (n === undefined || n === null) return '—';
  return String(n);
}

/**
 * Maps a signalstack dashboard participant payload onto the `Seeker`
 * shape the participant table expects.
 *
 * Signalstack's dashboard endpoint returns participant summaries only
 * — `name`, `city`, and the role/exp profile fields are NOT in this
 * response. They live in the per-user item detail endpoint, which the
 * table does not yet call. Missing fields render as em-dashes; the
 * `complete` profile bar uses `profile_completion_pct` directly so the
 * progress indicator stays meaningful.
 */
function toSeekerRow(
  participant: Record<string, unknown>,
  locale: string,
  lifecycleByItemId?: Map<
    string,
    { lifecycle_status: LifecycleStatus; completion_pct: number | null }
  >,
): Seeker {
  const userId =
    typeof participant.owner_user_id === 'string'
      ? participant.owner_user_id
      : typeof participant.user_id === 'string'
        ? participant.user_id
        : '';
  const status = mapSeekerStatus(
    typeof participant.profile_status === 'string' ? participant.profile_status : null,
  );
  const completion =
    typeof participant.profile_completion_pct === 'number' ? participant.profile_completion_pct : 0;
  // Lifecycle merge: signalstack's dashboard rollup may surface `item_id`
  // (open-shape items). When present + matched against the lifecycle
  // items fetch, we attach lifecycle_status + completion_pct so the new
  // column renders accurately. Unmatched rows fall through with
  // undefined — the LifecyclePill back-compat renders them as 'Live'.
  const itemId = typeof participant.item_id === 'string' ? participant.item_id : null;
  const merged = itemId ? lifecycleByItemId?.get(itemId) : undefined;
  const lifecycleFields: Pick<Seeker, 'lifecycle_status' | 'completion_pct'> = {};
  if (merged) {
    lifecycleFields.lifecycle_status = merged.lifecycle_status;
    if (merged.completion_pct !== null) {
      lifecycleFields.completion_pct = merged.completion_pct;
    }
  }
  const created =
    typeof participant.profile_created_at === 'string' ? participant.profile_created_at : '';
  const updated =
    typeof participant.profile_last_updated_at === 'string'
      ? participant.profile_last_updated_at
      : '';
  const name =
    typeof participant.name === 'string' && participant.name.trim() ? participant.name : '—';
  return {
    id: userId,
    name,
    city: '—',
    joined: created
      ? new Intl.DateTimeFormat(locale, {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }).format(new Date(created))
      : '—',
    avatar: avatarInitials(name),
    profile: { title: '—', exp: '—', verified: false, complete: completion },
    applied: {
      total:
        numberOr(participant.count_create, 0) +
        numberOr(participant.count_accept, 0) +
        numberOr(participant.count_reject, 0) +
        numberOr(participant.count_cancel, 0),
      accepted: numberOr(participant.count_accept, 0),
      rejected: numberOr(participant.count_reject, 0),
      pending: numberOr(participant.count_create, 0),
      cancelled: numberOr(participant.count_cancel, 0),
    },
    status,
    last: updated ? formatRelative(updated) : '—',
    actionableTags: Array.isArray(participant.actionable_tags)
      ? (participant.actionable_tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    ...lifecycleFields,
  };
}

function mapSeekerStatus(raw: string | null): ParticipantStatus {
  if (raw === 'at_risk') return 'at-risk';
  if (raw === 'inactive') return 'inactive';
  return 'active';
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}

function avatarInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '—') return '??';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase() || '??';
  const last = parts[parts.length - 1] ?? '';
  const initials = (first.charAt(0) + last.charAt(0)).toUpperCase();
  return initials || '??';
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function ProvidersTab() {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  // Mirror SeekersTab: live counts come from the signalstack dashboard
  // rollup. Provider domain reuses the same canonical rollup shape
  // (total_items, by_status, by_action_status, complete_profiles, …)
  // so the cards map field-for-field; only the labels differ.
  //
  // Domain id from cfg so networks declaring non-default ids (e.g.
  // orange_dot's `practitioner`) still pick the right by_domain slice.
  const { data: cfgRaw } = useAggregatorConfig();
  // No fallback — see SeekersTab.
  const providerDomainId = cfgRaw?.domains?.[1]?.id;
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [lifecycleFilter, setLifecycleFilter] = useLifecycleUrlFilter();
  const handleStatusFilterChange = (next: StatusFilter) => {
    setPage(1);
    setStatusFilter(next);
  };
  const handleLifecycleFilterChange = (next: LifecycleFilterValue) => {
    setPage(1);
    setLifecycleFilter(next);
  };
  const filterActive = statusFilter !== 'all';
  const {
    data: dashboard,
    isLoading,
    isError,
  } = useDashboard(
    providerDomainId
      ? {
          domain: providerDomainId,
          page,
          limit: PAGE_SIZE,
          ...(filterActive ? { status: statusFilter } : {}),
        }
      : undefined,
  );
  // Parallel fetch for lifecycle tiles + per-item lifecycle map.
  // Mirrors SeekersTab; see comments there for the full rationale.
  const lifecycleArg: LifecycleFilter | undefined =
    lifecycleFilter === 'all' ? undefined : lifecycleFilter;
  const { data: lifecycleItems } = useDashboardItems(
    providerDomainId
      ? {
          domain: providerDomainId,
          ...(lifecycleArg ? { lifecycle: lifecycleArg } : {}),
        }
      : undefined,
  );
  const lifecycleByItemId = useMemo(
    () => buildLifecycleByItemId(lifecycleItems?.items),
    [lifecycleItems?.items],
  );
  const { data: cfg } = useAggregatorConfig();
  const providerCfg = cfg?.domains?.find((d) => d.id === providerDomainId);
  const providerTileLabels = providerCfg?.dashboardTiles ?? {};
  const providerPlural = providerCfg?.plural_label ?? t('tabs.providers');
  // by_action_status bucket labels — wired to the funnel cells in the
  // participant table's action-count columns.
  const bucketLabels = cfg?.dashboardBuckets?.by_action_status ?? {};
  const statusLabels = cfg?.dashboardBuckets?.by_status ?? {};
  const statusRules = indexStatusRules(providerCfg?.status_rules);
  const slice = providerDomainId ? dashboard?.by_domain[providerDomainId] : undefined;
  const rollup = slice?.rollup;
  const total = rollup?.total_items;
  const byStatus = rollup?.by_status ?? {};
  const active = byStatus['active'] ?? byStatus['new'];
  const atRisk = byStatus['at_risk'];
  const inactive = byStatus['inactive'];
  const verified = rollup?.complete_profiles;
  const hasApplications = rollup?.has_applications;
  const rows = useMemo(
    () => (slice?.items ?? []).map((p) => toProviderRow(p, locale, lifecycleByItemId)),
    [slice?.items, locale, lifecycleByItemId],
  );
  const [cachedByStatus, setCachedByStatus] = useState<Record<string, number> | undefined>();
  useEffect(() => {
    if (!filterActive && rollup?.by_status) {
      setCachedByStatus(rollup.by_status);
    }
  }, [filterActive, rollup?.by_status]);
  const statusOptions = useMemo(
    () => buildStatusOptions(cachedByStatus ?? byStatus, t('filters.all_statuses')),
    [cachedByStatus, byStatus, t],
  );

  // Refresh handler: hits the BFF with refresh=true to force signalstack to
  // recompute the rollup synchronously, then invalidates the React Query
  // cache so the next normal render picks up the freshly stored values.
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      if (!providerDomainId) return;
      await dashboardService.dashboard({
        domain: providerDomainId,
        page,
        limit: PAGE_SIZE,
        ...(filterActive ? { status: statusFilter } : {}),
        refresh: true,
      });
      await queryClient.invalidateQueries({
        queryKey: ['dashboard', 'dashboard', providerDomainId],
      });
      setLastRefreshedAt(Date.now());
    } catch (err) {
      console.error('Dashboard refresh failed', err);
      setRefreshError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-ink-700">{providerPlural}</span>
        <div className="flex items-center gap-2">
          <Button
            kind="ghost"
            icon={
              <I.refresh
                size={14}
                className={refreshing ? 'animate-spin' : undefined}
                aria-hidden="true"
              />
            }
            onClick={() => {
              void handleRefresh();
            }}
            disabled={refreshing}
            aria-label={t('aria.refresh')}
            title={t('aria.refresh')}
          >
            {refreshing ? t('buttons.refreshing') : t('buttons.refresh')}
          </Button>
          {refreshError ? (
            <span className="ml-2 max-w-[220px] truncate text-xs text-red-600" title={refreshError}>
              {t('state.refreshFailed')}
            </span>
          ) : lastRefreshedAt !== null && Date.now() - lastRefreshedAt < 5000 ? (
            <span className="text-xs text-ink-400">{t('state.refreshedJustNow')}</span>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          tone="new"
          icon="spark"
          count={fmtCount(byStatus['new'] ?? 0)}
          label={statusRules['new']?.label ?? statusLabels['new'] ?? t('statuses.new')}
          hint={statusRules['new']?.description ?? t('hints.new')}
        />
        <StatCard
          tone="active"
          icon="briefcase"
          count={fmtCount(active)}
          label={statusRules['active']?.label ?? statusLabels['active'] ?? t('statuses.active')}
          hint={statusRules['active']?.description ?? t('hints.active')}
        />
        <StatCard
          tone="risk"
          icon="alert"
          count={fmtCount(atRisk)}
          label={statusRules['at_risk']?.label ?? statusLabels['at_risk'] ?? t('statuses.at_risk')}
          hint={statusRules['at_risk']?.description ?? t('hints.at_risk')}
        />
        <StatCard
          tone="inactive"
          icon="pause"
          count={fmtCount(inactive)}
          label={
            statusRules['inactive']?.label ?? statusLabels['inactive'] ?? t('statuses.inactive')
          }
          hint={statusRules['inactive']?.description ?? t('hints.inactive')}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <MiniStat
          label={
            providerTileLabels.total_items ??
            t('ministat.totalItems', { entityPlural: providerPlural })
          }
          value={fmtCount(total)}
        />
        <MiniStat
          label={providerTileLabels.complete_profiles ?? t('ministat.completeProfiles')}
          value={fmtCount(verified)}
        />
        <MiniStat
          label={
            providerTileLabels.has_applications ??
            t('ministat.withApplications', { entityPlural: providerPlural })
          }
          value={fmtCount(hasApplications)}
        />
      </div>

      {isLoading ? (
        <LoadingCard />
      ) : isError ? (
        <ErrorCard />
      ) : (
        <ParticipantTable<Provider>
          kind="provider"
          rows={rows}
          total={slice?.total_matching ?? total}
          page={page}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          statusFilter={statusFilter}
          onStatusFilterChange={handleStatusFilterChange}
          statusOptions={statusOptions}
          bucketLabels={bucketLabels}
          lifecycleFilter={lifecycleFilter}
          onLifecycleFilterChange={handleLifecycleFilterChange}
        />
      )}
    </div>
  );
}

function toProviderRow(
  participant: Record<string, unknown>,
  locale: string,
  lifecycleByItemId?: Map<
    string,
    { lifecycle_status: LifecycleStatus; completion_pct: number | null }
  >,
): Provider {
  const seeker = toSeekerRow(participant, locale, lifecycleByItemId);
  return { ...seeker, role: '—' };
}

function OppProvidersTab() {
  const t = useTranslations('dashboard');
  const { data, isLoading, isError } = useOppProviders();
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          tone="active"
          icon="spark"
          count="11"
          label={t('opp.activeProgramsLabel')}
          hint={t('opp.activeProgramsHint')}
        />
        <StatCard
          tone="satisfied"
          icon="check"
          count="5"
          label={t('opp.onboardedLabel')}
          hint={t('opp.onboardedHint')}
        />
        <StatCard
          tone="risk"
          icon="alert"
          count="2"
          label={t('opp.atRiskLabel')}
          hint={t('opp.atRiskHint')}
        />
        <StatCard
          tone="inactive"
          icon="pause"
          count="0"
          label={t('opp.inactiveLabel')}
          hint={t('opp.inactiveHint')}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MiniStat label={t('opp.totalPrograms')} value="18" delta="+2" deltaTone="up" />
        <MiniStat label={t('opp.activeCohorts')} value="31" delta="+5" deltaTone="up" />
        <MiniStat label={t('opp.traineesEngaged')} value="612" delta="+58" deltaTone="up" />
        <MiniStat label={t('opp.placementRate')} value="46%" delta="↑ 4%" deltaTone="up" />
      </div>

      {isLoading ? (
        <LoadingCard />
      ) : isError ? (
        <ErrorCard />
      ) : (
        <ParticipantTable kind="opp" rows={data ?? []} />
      )}
    </div>
  );
}

/**
 * Builds the seeker tab label with the live participants_total from the
 * signalstack dashboard. Dot + count are suppressed while the rollup
 * loads so the chip doesn't flash a stale "·" with no number.
 *
 * @param count - Live total from the dashboard rollup; omit to suppress the chip.
 * @param label - Localised tab label string (e.g. from `t('tabs.seekers')`).
 */
function seekerTabLabel(count: number | undefined, label: string): SegmentedTab<Tab> {
  return {
    id: 'seekers',
    label: (
      <span className="inline-flex items-center gap-2">
        <I.users size={14} /> {label}
        {count !== undefined && (
          <>
            <span className="text-ink-300">·</span> {count}
          </>
        )}
      </span>
    ),
  };
}

/**
 * Builds the provider tab label. Count source is TBD — signalstack's
 * dashboard endpoint is seeker-only today, so the chip stays
 * count-less for the provider tab until the provider rollout lands.
 *
 * @param count - Live total from the dashboard rollup; omit to suppress the chip.
 * @param label - Localised tab label string (e.g. from `t('tabs.providers')`).
 */
function providerTabLabel(count: number | undefined, label: string): SegmentedTab<Tab> {
  return {
    id: 'providers',
    label: (
      <span className="inline-flex items-center gap-2">
        <I.briefcase size={14} /> {label}
        {count !== undefined && (
          <>
            <span className="text-ink-300">·</span> {count}
          </>
        )}
      </span>
    ),
  };
}

export default function DashboardPageRoot() {
  const rawProfile = useProfileRaw();
  // Wait for the profile to resolve before mounting any tab — the SeekersTab
  // and ProvidersTab kick off their own /api/dashboard/items?domain=... fetch
  // on mount, so rendering a default before we know the aggregator's type
  // fires a stale seeker request that a provider account should never make.
  const profileType = rawProfile.data?.type;
  if (!profileType) {
    return <DashboardLoadingFrame />;
  }
  return <DashboardContent aggregatorType={profileType} />;
}

function DashboardLoadingFrame() {
  const t = useTranslations('dashboard');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  return (
    <div className="fade-up">
      <Topbar
        title={`My ${cfg.network.display_name ?? cfg.brand.short_name}`}
        subtitle={cfg.brand.tagline ?? 'Track every participant in your network — at a glance.'}
      />
      <div className="text-center text-[13px] text-ink-400 py-12">{t('state.loading')}</div>
    </div>
  );
}

function DashboardContent({ aggregatorType }: { aggregatorType: string }) {
  const router = useRouter();
  const t = useTranslations('dashboard');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  // Resolve the aggregator's primary domain id strictly from the live
  // network config (matches against `aggregatorType`). No fallback:
  // when the config has not loaded yet, `primaryDomain` is undefined
  // and `useDashboard` skips the request — preventing a stale
  // `?domain=seeker` fetch on cold mount with DEFAULT_AGGREGATOR_CONFIG.
  const primaryDomainCfg = cfg.domains?.find((d) => d.id === aggregatorType);
  const primaryDomain = primaryDomainCfg?.id;
  const isProviderLike = !!primaryDomain && primaryDomain === cfg.domains?.[1]?.id;
  const { data: dashboard } = useDashboard(primaryDomain ? { domain: primaryDomain } : undefined);
  const liveCount = primaryDomain
    ? dashboard?.by_domain[primaryDomain]?.rollup.total_items
    : undefined;
  // Tab label reads from the network config's `plural_label` so orange's
  // `tourist` renders as "Tourists" not "Seekers".
  const primaryLabel =
    primaryDomainCfg?.plural_label ?? (isProviderLike ? t('tabs.providers') : t('tabs.seekers'));
  const tabItems = useMemo<SegmentedTab<Tab>[]>(
    () =>
      isProviderLike
        ? [providerTabLabel(liveCount, primaryLabel)]
        : [seekerTabLabel(liveCount, primaryLabel)],
    [isProviderLike, liveCount, primaryLabel],
  );
  const [tab, setTab] = useState<Tab>(isProviderLike ? 'providers' : 'seekers');

  return (
    <div className="fade-up">
      <Topbar
        title={`My ${cfg.network.display_name ?? cfg.brand.short_name}`}
        subtitle={cfg.brand.tagline ?? 'Track every participant in your network — at a glance.'}
        right={
          <div className="flex items-center gap-2">
            <Button icon={<I.plus size={14} />} onClick={() => router.push('/onboarding')}>
              {t('buttons.addParticipants')}
            </Button>
          </div>
        }
      />

      {tabItems.length > 1 ? (
        <SegmentedTabs<Tab> value={tab} onChange={setTab} items={tabItems} className="mb-6" />
      ) : (
        // Single-domain aggregator: the lone tab carries no navigation
        // value, so render it as a static label chip instead of a
        // clickable button.
        <div className="seg mb-6">
          <span className="px-4 py-2 rounded-[9px] text-[13.5px] font-medium bg-[var(--bd-card)] text-[var(--bd-primary-600)] inline-flex items-center gap-2 shadow-[0_1px_2px_rgba(11,16,32,0.06)] cursor-default select-none">
            {tabItems[0]?.label}
          </span>
        </div>
      )}

      {tab === 'seekers' && <SeekersTab />}
      {tab === 'providers' && <ProvidersTab />}
      {tab === 'opp' && <OppProvidersTab />}
    </div>
  );
}
