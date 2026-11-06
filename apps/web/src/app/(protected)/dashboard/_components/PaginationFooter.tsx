'use client';

/**
 * Table footer with the row range and page buttons (`web` app).
 */
import { useTranslations } from 'next-intl';
import { I } from '@/icons';
import { PAGE_GAP, buildPageList } from '../_lib/pagination';

/** Props for {@link PaginationFooter}. */
export interface PaginationFooterProps {
  page: number;
  pageSize: number;
  total: number;
  rowsOnPage: number;
  onPageChange?: ((next: number) => void) | undefined;
  /** True while a search is active; hides page buttons and shows the filtered count. */
  searchActive?: boolean | undefined;
  visibleCount?: number | undefined;
}

/**
 * Shows "Showing X–Y of Z" and, when there is more than one page, the page buttons.
 */
export function PaginationFooter({
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
  // During a search, show the filtered count of the current page.
  const showSearchSummary = searchActive && visibleCount !== undefined;
  const change = (next: number) => {
    if (!onPageChange) return;
    if (next < 1 || next > totalPages || next === page) return;
    onPageChange(next);
  };
  const pageList = buildPageList(page, totalPages);
  return (
    <div className="px-5 py-3 border-t border-(--bd-border) flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-[12.5px] text-ink-500">
      <div className="text-center sm:text-left">
        {showSearchSummary
          ? t('pagination.matching', { shown: visibleCount, rowsOnPage })
          : t('pagination.showing', { from: start, to: end, total })}
      </div>
      {totalPages > 1 && !searchActive && (
        <div className="flex flex-wrap items-center justify-center gap-1">
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
            p === PAGE_GAP ? (
              // A gap's position in the list is its identity.
              <span key={`gap-${i}`} className="px-2 text-ink-300 select-none">
                {PAGE_GAP}
              </span>
            ) : p === page ? (
              <button
                key={p}
                type="button"
                aria-current="page"
                className="px-3 py-1 rounded-md bg-(--bd-primary-50) text-primary-600 font-semibold"
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
