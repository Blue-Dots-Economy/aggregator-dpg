'use client';

/**
 * Participant table of the dashboard: toolbar, selection, rows and pagination (`web` app).
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { I } from '@/icons';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '@/hooks/useAggregatorConfig';
import type { ParticipantBase } from '@/types';
import { parseLifecycleParam, type LifecycleFilterValue } from '../_lib/lifecycle';
import { isSelectableRow } from '../_lib/rows';
import type { StatusFilter, StatusOption } from '../_lib/status';
import { BulkActionBar } from './BulkActionBar';
import { PaginationFooter } from './PaginationFooter';
import { ParticipantRow } from './ParticipantRow';
import { SelectAllBanner } from './SelectAllBanner';
import { StatusFilterMenu } from './StatusFilterMenu';
import { useRowSelection } from './useRowSelection';

/** Which table variant to render. */
export type RowKind = 'seeker' | 'provider' | 'opp';

/** Rows shown per page when the caller does not pass a page size. */
const DEFAULT_TABLE_PAGE_SIZE = 25;

/** Minimum table width (px) before the selection column, by row kind. */
const TABLE_MIN_WIDTH = { provider: 1500, other: 1400 } as const;

/** Width (px) of the selection column. */
const SELECT_COLUMN_WIDTH = 44;

/** Height (px) of the scrolling table body. */
const TABLE_MAX_HEIGHT = 520;

/** Props for {@link ParticipantTable}. */
export interface ParticipantTableProps<R extends ParticipantBase> {
  kind: RowKind;
  /** Domain id for this table, from network config. Defaults from `kind` when omitted. */
  domain?: string | undefined;
  rows: R[];
  /** Total from signalstack `total_matching`, used for pagination. */
  total?: number | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
  onPageChange?: ((next: number) => void) | undefined;
  /** Server-side status filter. `'all'` sends no `?status=`. */
  statusFilter?: StatusFilter | undefined;
  onStatusFilterChange?: ((next: StatusFilter) => void) | undefined;
  /** Statuses for this domain, from `rollup.by_status`. */
  statusOptions?: StatusOption[] | undefined;
  /** Initiated-column bucket labels from config; falls back to `t('buckets.*')`. */
  initiatedLabels?: Record<string, string> | undefined;
  /** Received-column bucket labels from config; falls back to `t('buckets.*')`. */
  receivedLabels?: Record<string, string> | undefined;
  /** Active lifecycle dropdown value. `'all'` hides the URL param. */
  lifecycleFilter?: LifecycleFilterValue | undefined;
  onLifecycleFilterChange?: ((next: LifecycleFilterValue) => void) | undefined;
  /**
   * Fetches every row matching the current filter.
   *
   * Omit to hide the "Select all N matching" banner.
   */
  onSelectAllMatching?: (() => Promise<R[]>) | undefined;
}

/** Text the search box matches: name, id, city and, for providers, role. */
function searchText(row: ParticipantBase): string {
  const role = 'role' in row && typeof row.role === 'string' ? row.role : '';
  return [row.name, row.id, row.city, role].join(' ').toLowerCase();
}

/**
 * Table of participants with search, lifecycle and status filters, row
 * selection with bulk actions, and pagination.
 *
 * Search filters the current page only. The selection is kept across pages
 * and cleared when a filter changes.
 */
export function ParticipantTable<R extends ParticipantBase>({
  kind,
  domain,
  rows,
  total,
  page = 1,
  pageSize = DEFAULT_TABLE_PAGE_SIZE,
  onPageChange,
  statusFilter = 'all',
  onStatusFilterChange,
  statusOptions,
  initiatedLabels = {},
  receivedLabels = {},
  lifecycleFilter = 'all',
  onLifecycleFilterChange,
  onSelectAllMatching,
}: ParticipantTableProps<R>) {
  const t = useTranslations('dashboard');
  const { data: tableCfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  // Heading entity label from the network config's singular `label`.
  const headingEntity =
    tableCfg.domains?.find((d) => d.id === domain)?.label ??
    (kind === 'provider' ? t('table.provider') : t('table.participant'));
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
  const [query, setQuery] = useState('');

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => searchText(r).includes(q));
  }, [rows, query]);

  // Domain id for bulk actions. Falls back to `kind` when no domain is passed.
  const bulkDomain: string = domain ?? (kind === 'seeker' ? 'seeker' : 'provider');

  const selection = useRowSelection(`${statusFilter}|${lifecycleFilter}`);
  const { selected, selectedAllMatching } = selection;
  // In-flight guard while the fetch-all-matching call runs.
  const [selectingAll, setSelectingAll] = useState(false);

  const selectablePageRows = visibleRows.filter(isSelectableRow);
  const allPageSelected =
    selectablePageRows.length > 0 && selectablePageRows.every((r) => selected.has(r.id));

  /**
   * Header checkbox toggle.
   *
   * Clears the selection if any rows are selected; otherwise selects the current page.
   */
  const togglePage = () => {
    if (selected.size > 0) selection.clear();
    else selection.selectRows(selectablePageRows);
  };

  const selectAllMatching = async () => {
    if (!onSelectAllMatching || selectingAll) return;
    setSelectingAll(true);
    try {
      selection.selectAllMatching(await onSelectAllMatching());
    } finally {
      setSelectingAll(false);
    }
  };

  // Show "select all N matching" when the whole page is selected, more rows
  // exist, and the parent can fetch them.
  const showSelectAllMatching =
    !!onSelectAllMatching &&
    allPageSelected &&
    !selectedAllMatching &&
    typeof total === 'number' &&
    total > selectablePageRows.length;

  const minWidth =
    (kind === 'provider' ? TABLE_MIN_WIDTH.provider : TABLE_MIN_WIDTH.other) + SELECT_COLUMN_WIDTH;

  return (
    <div className="bd-card bd-shadow overflow-hidden">
      <div className="px-5 py-4 flex flex-wrap sm:flex-nowrap items-center gap-3 border-b border-(--bd-border)">
        <div className="font-display font-bold text-[15px] text-ink-900">
          {kind === 'opp'
            ? t('table.opportunityProviders')
            : `${headingEntity} ${t('table.activitySuffix')}`}
        </div>
        <span className="text-[12px] text-ink-400">
          {t('table.count', { shown: visibleRows.length, total: total ?? rows.length })}
        </span>

        {/* Below `sm` the controls wrap onto a full-width row with the filter
            button on the right. From `sm` up they stay on one row. */}
        <div className="w-full sm:w-auto sm:ml-auto flex flex-wrap sm:flex-nowrap items-center gap-2">
          <div className="relative basis-full sm:basis-auto">
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
              className="bd-input w-full sm:w-[360px] sm:shrink-0 text-[13px] py-1.5"
              style={{ paddingLeft: 36 }}
              placeholder={
                kind === 'seeker' ? t('search.seekerPlaceholder') : t('search.providerPlaceholder')
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {onLifecycleFilterChange ? (
            <select
              aria-label={t('filters.lifecycle_label')}
              className="bd-input w-auto max-w-[150px] text-[12.5px] py-1.5 pr-7 flex-1 sm:flex-initial"
              value={lifecycleFilter}
              onChange={(e) => onLifecycleFilterChange(parseLifecycleParam(e.target.value))}
            >
              <option value="all">{t('filters.lifecycle_all')}</option>
              <option value="draft">{t('filters.lifecycle_draft')}</option>
              <option value="live">{t('filters.lifecycle_live')}</option>
            </select>
          ) : null}
          <StatusFilterMenu
            value={statusFilter}
            options={options}
            onChange={onStatusFilterChange}
          />
        </div>
      </div>

      {selected.size > 0 && (
        <BulkActionBar
          selectedRows={[...selected.values()]}
          domain={bulkDomain}
          onClear={selection.clear}
        />
      )}

      {(showSelectAllMatching || selectedAllMatching) && (
        <SelectAllBanner
          selectedAllMatching={selectedAllMatching}
          selectedCount={selected.size}
          pageCount={selectablePageRows.length}
          total={total ?? 0}
          selecting={selectingAll}
          onSelectAll={() => void selectAllMatching()}
          onClear={selection.clear}
        />
      )}

      <div className="overflow-auto scroll-x" style={{ maxHeight: TABLE_MAX_HEIGHT }}>
        <table className="bd-table" style={{ minWidth }}>
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
                className="bd-sticky-col"
                style={{
                  zIndex: 5,
                  background: 'var(--bd-table-head-bg)',
                  width: SELECT_COLUMN_WIDTH,
                  minWidth: SELECT_COLUMN_WIDTH,
                }}
              >
                <input
                  type="checkbox"
                  className="w-4 h-4 cursor-pointer align-middle"
                  style={{ accentColor: 'var(--bd-primary-600)' }}
                  ref={(el) => {
                    // Indeterminate when a selection exists but this page is not fully selected.
                    if (el) el.indeterminate = selected.size > 0 && !allPageSelected;
                  }}
                  checked={allPageSelected}
                  onChange={togglePage}
                  disabled={selectablePageRows.length === 0 && selected.size === 0}
                  aria-label={t('aria.select_all_page')}
                />
              </th>
              <th
                className="bd-sticky-col bd-sticky-col-2"
                style={{
                  zIndex: 5,
                  background: 'var(--bd-table-head-bg)',
                  minWidth: 240,
                }}
              >
                {kind === 'seeker' ? t('table.participant') : t('table.provider')}
              </th>
              <th>{t('table.joined')}</th>
              <th>{t('table.profileStatus')}</th>
              <th>{t('table.initiated')}</th>
              <th>{t('table.received')}</th>
              <th>{t('table.status')}</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <ParticipantRow
                key={r.id}
                row={r}
                selectable={isSelectableRow(r)}
                selected={selected.has(r.id)}
                onToggle={() => selection.toggleRow(r)}
                initiatedLabels={initiatedLabels}
                receivedLabels={receivedLabels}
                bucketFallback={getBucketFallback}
              />
            ))}
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
