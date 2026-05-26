'use client';

import { useEffect, useState, useRef, useMemo, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../components/ui/Button';
import { StatusPill } from '../../../components/ui/StatusPill';
import { Avatar } from '../../../components/ui/Avatar';
import { SegmentedTabs, type SegmentedTab } from '../../../components/ui/SegmentedTabs';
import { Topbar } from '../../../components/shell/Topbar';
import { I, type IconName } from '../../../icons';
import { useOppProviders, useDashboard } from '../../../hooks/useDashboard';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';
import { dashboardService, triggerCsvDownload } from '../../../services/dashboard.service';
import { useProfileRaw } from '../../../hooks/useProfile';
import { useThemeMode } from '../../../lib/theme-mode';
import type { ParticipantBase, ParticipantStatus, Provider, Seeker } from '../../../types';

type Tab = 'seekers' | 'providers' | 'opp';

/** Fallback bucket labels used when network.json doesn't override them. */
const DEFAULT_BUCKET_LABELS: Record<string, string> = {
  create: 'Created',
  accept: 'Accepted',
  reject: 'Rejected',
  cancel: 'Cancelled',
};

/** Fallback status labels used when network.json doesn't override them. */
const DEFAULT_STATUS_LABELS: Record<string, string> = {
  new: 'New',
  active: 'Active',
  at_risk: 'At Risk',
  inactive: 'Inactive',
};

type StatTone = 'active' | 'risk' | 'inactive' | 'satisfied';

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

type StatusFilter = string; // 'all' | any key signalstack returns in rollup.by_status

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

function buildStatusOptions(byStatus: Record<string, number> | undefined): StatusOption[] {
  const opts: StatusOption[] = [{ value: 'all', label: 'All statuses' }];
  if (!byStatus) return opts;
  for (const [key, count] of Object.entries(byStatus)) {
    if (!key) continue;
    opts.push({ value: key, label: statusLabel(key), count });
  }
  return opts;
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
}: ParticipantTableProps<R>) {
  const options: StatusOption[] = statusOptions ?? [{ value: 'all', label: 'All statuses' }];
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
            ? 'Participants'
            : kind === 'opp'
              ? 'Opportunity Providers'
              : 'Providers'}
        </div>
        <span className="text-[12px] text-ink-400">
          {visibleRows.length} of {total ?? rows.length}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <label htmlFor={searchId} className="sr-only">
              Search participants
            </label>
            <I.search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
            />
            <input
              id={searchId}
              aria-label="Search participants"
              className="bd-input w-[320px] text-[13px] py-1.5"
              style={{ paddingLeft: 36 }}
              placeholder={
                kind === 'seeker' ? 'Search name, ID, profile…' : 'Search org, role, ID…'
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
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
            title={exportError ?? 'Export as CSV'}
            aria-label="Export as CSV"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        </div>
      </div>

      <div className="overflow-auto scroll-x" style={{ maxHeight: 520 }}>
        <table className="bd-table" style={{ minWidth: kind === 'provider' ? 1180 : 1080 }}>
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
                {kind === 'seeker' ? 'Participant' : 'Provider'}
              </th>
              <th>Joined</th>
              {kind === 'provider' && <th>Job Role</th>}
              <th>Profile Status</th>
              <th>Applied</th>
              <th>Pre-shortlisted</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => {
              const roleParts =
                kind === 'provider' ? (r as unknown as Provider).role.split(' · ') : [];
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
                  {kind === 'provider' && (
                    <td>
                      <div className="text-[13px] font-medium text-ink-800">
                        {roleParts[0] ?? ''}
                      </div>
                      <div className="text-[11px] text-ink-400 mt-0.5">{roleParts[1] ?? ''}</div>
                    </td>
                  )}
                  <td>
                    <ProgressTiny pct={r.profile.complete} />
                  </td>
                  <td>
                    <FunnelCell
                      total={r.applied.total}
                      parts={[
                        {
                          v: r.applied.shortlisted ?? 0,
                          color: '#10B981',
                          label: 'Shortlisted',
                          short: 'Shortlisted',
                        },
                        {
                          v: r.applied.rejected,
                          color: '#EF4444',
                          label: 'Rejected',
                          short: 'Rejected',
                        },
                        {
                          v: r.applied.pending,
                          color: '#F59E0B',
                          label: 'Pending',
                          short: 'Pending',
                        },
                      ]}
                    />
                  </td>
                  <td>
                    <FunnelCell
                      total={r.pre.total}
                      parts={[
                        {
                          v: r.pre.accepted ?? 0,
                          color: '#6366F1',
                          label: 'Accepted',
                          short: 'Accepted',
                        },
                        {
                          v: r.pre.rejected,
                          color: '#EF4444',
                          label: 'Rejected',
                          short: 'Rejected',
                        },
                        {
                          v: r.pre.pending,
                          color: '#F59E0B',
                          label: 'Pending',
                          short: 'Pending',
                        },
                      ]}
                    />
                  </td>
                  <td>
                    <StatusPill status={r.status} />
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
          ? `Matching ${visibleCount} of ${rowsOnPage} on this page`
          : `Showing ${start}–${end} of ${total}`}
      </div>
      {totalPages > 1 && !searchActive && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous page"
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
            aria-label="Next page"
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
  return (
    <div className="bd-card bd-shadow p-8 text-[13px] text-ink-400" style={{ opacity: 0.6 }}>
      Loading…
    </div>
  );
}

function ErrorCard() {
  return (
    <div className="bd-card bd-shadow p-8 text-[13px] text-rose-600">
      Failed to load. Please try again.
    </div>
  );
}

const PAGE_SIZE = 25;

function SeekersTab() {
  // Signalstack's `/aggregator/dashboard` is the only endpoint that
  // correctly scopes participant lookups by the caller's signalstack org
  // (via the per-call `x-acting-org-id` header). The response now
  // wraps every served domain under `by_domain[<id>]` so seeker +
  // provider tabs share a single fetch.
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const handleStatusFilterChange = (next: StatusFilter) => {
    setPage(1);
    setStatusFilter(next);
  };
  const filterActive = statusFilter !== 'all';
  const {
    data: dashboard,
    isLoading,
    isError,
  } = useDashboard({
    domain: 'seeker',
    page,
    limit: PAGE_SIZE,
    ...(filterActive ? { status: statusFilter } : {}),
  });
  const slice = dashboard?.by_domain.seeker;
  const rollup = slice?.rollup;
  const { data: cfg } = useAggregatorConfig();
  const seekerCfg = cfg?.domains?.find((d) => d.id === 'seeker');
  const seekerTileLabels = seekerCfg?.dashboardTiles ?? {};
  const seekerPlural = seekerCfg?.plural_label ?? 'Seekers';
  // by_action_status bucket labels — used by the breakdown chips rendered in
  // the participant table's action-count columns. Prefixed _ until Task 11
  // wires the chip component.
  const _bucketLabels = cfg?.dashboardBuckets?.by_action_status ?? DEFAULT_BUCKET_LABELS;
  const statusLabels = cfg?.dashboardBuckets?.by_status ?? DEFAULT_STATUS_LABELS;
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
    () => buildStatusOptions(cachedByStatus ?? byStatus),
    [cachedByStatus, byStatus],
  );
  // Signalstack's status taxonomy is open — pick the keys the UI cares
  // about; unknown ones still surface in the items list.
  const active = byStatus['active'] ?? byStatus['new'];
  const atRisk = byStatus['at_risk'];
  const inactive = byStatus['inactive'];
  const completeProfiles = rollup?.complete_profiles;
  const hasApplications = rollup?.has_applications;
  const newThisWeek = byStatus['new'];
  const rows = useMemo(() => (slice?.items ?? []).map(toSeekerRow), [slice?.items]);

  // Refresh handler: hits the BFF with refresh=true to force signalstack to
  // recompute the rollup synchronously, then invalidates the React Query
  // cache so the next normal render picks up the freshly stored values.
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await dashboardService.dashboard({
        domain: 'seeker',
        page,
        limit: PAGE_SIZE,
        ...(filterActive ? { status: statusFilter } : {}),
        refresh: true,
      });
      await queryClient.invalidateQueries({
        queryKey: ['dashboard', 'dashboard', 'seeker'],
      });
      setLastRefreshedAt(Date.now());
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
            aria-label="Refresh dashboard"
            title="Refresh dashboard"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          {lastRefreshedAt !== null && Date.now() - lastRefreshedAt < 5000 ? (
            <span className="text-xs text-ink-400">Refreshed just now</span>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          tone="active"
          icon="users"
          count={fmtCount(active)}
          label={statusLabels['active'] ?? `Active ${seekerPlural}`}
          hint="New or recently active"
        />
        <StatCard
          tone="risk"
          icon="alert"
          count={fmtCount(atRisk)}
          label={statusLabels['at_risk'] ?? 'At Risk'}
          hint="No activity 14–30 days"
        />
        <StatCard
          tone="inactive"
          icon="pause"
          count={fmtCount(inactive)}
          label={statusLabels['inactive'] ?? 'Inactive'}
          hint="Dormant 30+ days"
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MiniStat
          label={seekerTileLabels.total_items ?? `Total ${seekerPlural}`}
          value={fmtCount(total)}
        />
        <MiniStat
          label={seekerTileLabels.complete_profiles ?? 'Complete Profiles'}
          value={fmtCount(completeProfiles)}
        />
        <MiniStat
          label={seekerTileLabels.has_applications ?? `${seekerPlural} with Applications`}
          value={fmtCount(hasApplications)}
        />
        <MiniStat
          label={statusLabels['new'] ?? 'New Participants'}
          value={fmtCount(newThisWeek)}
          delta="this week"
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
function toSeekerRow(participant: Record<string, unknown>): Seeker {
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
      ? new Date(created).toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : '—',
    avatar: avatarInitials(name),
    profile: { title: '—', exp: '—', verified: false, complete: completion },
    applied: {
      total:
        numberOr(participant.count_create, 0) +
        numberOr(participant.count_accept, 0) +
        numberOr(participant.count_reject, 0) +
        numberOr(participant.count_cancel, 0),
      shortlisted: 0,
      accepted: numberOr(participant.count_accept, 0),
      rejected: numberOr(participant.count_reject, 0),
      pending: numberOr(participant.count_create, 0),
    },
    pre: { total: 0, shortlisted: 0, accepted: 0, rejected: 0, pending: 0 },
    status,
    last: updated ? formatRelative(updated) : '—',
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
  // Mirror SeekersTab: live counts come from the signalstack dashboard
  // rollup. Provider domain reuses the same canonical rollup shape
  // (total_items, by_status, by_action_status, complete_profiles, …)
  // so the cards map field-for-field; only the labels differ.
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const handleStatusFilterChange = (next: StatusFilter) => {
    setPage(1);
    setStatusFilter(next);
  };
  const filterActive = statusFilter !== 'all';
  const {
    data: dashboard,
    isLoading,
    isError,
  } = useDashboard({
    domain: 'provider',
    page,
    limit: PAGE_SIZE,
    ...(filterActive ? { status: statusFilter } : {}),
  });
  const { data: cfg } = useAggregatorConfig();
  const providerCfg = cfg?.domains?.find((d) => d.id === 'provider');
  const providerTileLabels = providerCfg?.dashboardTiles ?? {};
  const providerPlural = providerCfg?.plural_label ?? 'Providers';
  // by_action_status bucket labels — prefixed _ until the chip component is wired.
  const _bucketLabels = cfg?.dashboardBuckets?.by_action_status ?? DEFAULT_BUCKET_LABELS;
  const statusLabels = cfg?.dashboardBuckets?.by_status ?? DEFAULT_STATUS_LABELS;
  const slice = dashboard?.by_domain.provider;
  const rollup = slice?.rollup;
  const total = rollup?.total_items;
  const byStatus = rollup?.by_status ?? {};
  const active = byStatus['active'] ?? byStatus['new'];
  const atRisk = byStatus['at_risk'];
  const inactive = byStatus['inactive'];
  const verified = rollup?.complete_profiles;
  const hasApplications = rollup?.has_applications;
  const rows = useMemo(() => (slice?.items ?? []).map(toProviderRow), [slice?.items]);
  const [cachedByStatus, setCachedByStatus] = useState<Record<string, number> | undefined>();
  useEffect(() => {
    if (!filterActive && rollup?.by_status) {
      setCachedByStatus(rollup.by_status);
    }
  }, [filterActive, rollup?.by_status]);
  const statusOptions = useMemo(
    () => buildStatusOptions(cachedByStatus ?? byStatus),
    [cachedByStatus, byStatus],
  );

  // Refresh handler: hits the BFF with refresh=true to force signalstack to
  // recompute the rollup synchronously, then invalidates the React Query
  // cache so the next normal render picks up the freshly stored values.
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await dashboardService.dashboard({
        domain: 'provider',
        page,
        limit: PAGE_SIZE,
        ...(filterActive ? { status: statusFilter } : {}),
        refresh: true,
      });
      await queryClient.invalidateQueries({
        queryKey: ['dashboard', 'dashboard', 'provider'],
      });
      setLastRefreshedAt(Date.now());
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
            aria-label="Refresh dashboard"
            title="Refresh dashboard"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          {lastRefreshedAt !== null && Date.now() - lastRefreshedAt < 5000 ? (
            <span className="text-xs text-ink-400">Refreshed just now</span>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          tone="active"
          icon="briefcase"
          count={fmtCount(active)}
          label={statusLabels['active'] ?? 'Active'}
          hint="Currently hiring"
        />
        <StatCard
          tone="risk"
          icon="alert"
          count={fmtCount(atRisk)}
          label={statusLabels['at_risk'] ?? 'At Risk'}
          hint="Stalled requirements"
        />
        <StatCard
          tone="inactive"
          icon="pause"
          count={fmtCount(inactive)}
          label={statusLabels['inactive'] ?? 'Inactive'}
          hint="No openings 30+ days"
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <MiniStat
          label={providerTileLabels.total_items ?? `Total ${providerPlural}`}
          value={fmtCount(total)}
        />
        <MiniStat
          label={providerTileLabels.complete_profiles ?? 'Complete Profiles'}
          value={fmtCount(verified)}
        />
        <MiniStat
          label={providerTileLabels.has_applications ?? `${providerPlural} with Applications`}
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
        />
      )}
    </div>
  );
}

function toProviderRow(participant: Record<string, unknown>): Provider {
  const seeker = toSeekerRow(participant);
  return { ...seeker, role: '—' };
}

function OppProvidersTab() {
  const { data, isLoading, isError } = useOppProviders();
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          tone="active"
          icon="spark"
          count="11"
          label="Active programs"
          hint="Cohorts running now"
        />
        <StatCard
          tone="satisfied"
          icon="check"
          count="5"
          label="Onboarded"
          hint="Producing placements"
        />
        <StatCard tone="risk" icon="alert" count="2" label="At Risk" hint="Low cohort completion" />
        <StatCard tone="inactive" icon="pause" count="0" label="Inactive" hint="None dormant" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MiniStat label="Total Programs" value="18" delta="+2" deltaTone="up" />
        <MiniStat label="Active Cohorts" value="31" delta="+5" deltaTone="up" />
        <MiniStat label="Trainees Engaged" value="612" delta="+58" deltaTone="up" />
        <MiniStat label="Placement Rate" value="46%" delta="↑ 4%" deltaTone="up" />
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
 */
function seekerTabLabel(count: number | undefined): SegmentedTab<Tab> {
  return {
    id: 'seekers',
    label: (
      <span className="inline-flex items-center gap-2">
        <I.users size={14} /> Seekers
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
 */
function providerTabLabel(count: number | undefined): SegmentedTab<Tab> {
  return {
    id: 'providers',
    label: (
      <span className="inline-flex items-center gap-2">
        <I.briefcase size={14} /> Providers
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
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  return (
    <div className="fade-up">
      <Topbar
        title={`My ${cfg.brand.short_name}`}
        subtitle={cfg.brand.tagline ?? 'Track every participant in your network — at a glance.'}
      />
      <div className="text-center text-[13px] text-ink-400 py-12">Loading…</div>
    </div>
  );
}

function DashboardContent({ aggregatorType }: { aggregatorType: 'seeker' | 'provider' }) {
  const router = useRouter();
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  // Tabs are scoped to the aggregator's registered participant focus —
  // seeker aggregators see only Seekers; provider aggregators see only
  // Providers. The opposite primary tab is hidden, not just disabled.
  // The chip count reads from the same signalstack dashboard rollup the
  // tab body renders, so the header total never drifts from the table.
  const { data: dashboard } = useDashboard({
    domain: aggregatorType === 'provider' ? 'provider' : 'seeker',
  });
  const liveCount =
    dashboard?.by_domain[aggregatorType === 'provider' ? 'provider' : 'seeker']?.rollup.total_items;
  const tabItems = useMemo<SegmentedTab<Tab>[]>(
    () =>
      aggregatorType === 'provider' ? [providerTabLabel(liveCount)] : [seekerTabLabel(liveCount)],
    [aggregatorType, liveCount],
  );
  const [tab, setTab] = useState<Tab>(aggregatorType === 'provider' ? 'providers' : 'seekers');

  return (
    <div className="fade-up">
      <Topbar
        title={`My ${cfg.brand.short_name}`}
        subtitle={cfg.brand.tagline ?? 'Track every participant in your network — at a glance.'}
        right={
          <div className="flex items-center gap-2">
            <Button icon={<I.plus size={14} />} onClick={() => router.push('/onboarding')}>
              Add Participants
            </Button>
          </div>
        }
      />

      <SegmentedTabs<Tab> value={tab} onChange={setTab} items={tabItems} className="mb-6" />

      {tab === 'seekers' && <SeekersTab />}
      {tab === 'providers' && <ProvidersTab />}
      {tab === 'opp' && <OppProvidersTab />}
    </div>
  );
}
