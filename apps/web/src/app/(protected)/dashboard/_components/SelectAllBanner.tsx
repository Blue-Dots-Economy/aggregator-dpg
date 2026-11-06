'use client';

/**
 * Banner that extends the table selection to every matching row (`web` app).
 */
import { useTranslations } from 'next-intl';

/** Props for {@link SelectAllBanner}. */
export interface SelectAllBannerProps {
  /** True once "Select all N matching" has run. */
  selectedAllMatching: boolean;
  /** False when fewer rows were read than matched. */
  complete: boolean;
  /** Message of a failed select-all, shown beside the button. */
  error: string | null;
  /** Number of selected rows, shown once every matching row is selected. */
  selectedCount: number;
  /** Number of selectable rows on this page. */
  pageCount: number;
  /** Number of rows matching the filters. */
  total: number;
  selecting: boolean;
  onSelectAll: () => void;
  onClear: () => void;
}

/**
 * Offers "Select all N matching", then confirms the selection with a clear action.
 *
 * When fewer rows were read than matched, it says how many were selected.
 */
export function SelectAllBanner({
  selectedAllMatching,
  complete,
  error,
  selectedCount,
  pageCount,
  total,
  selecting,
  onSelectAll,
  onClear,
}: SelectAllBannerProps) {
  const t = useTranslations('dashboard');
  return (
    <div className="px-5 py-2 flex items-center justify-center gap-2 border-b border-(--bd-border) bg-(--bd-primary-50) text-[12.5px] text-ink-600">
      {selectedAllMatching ? (
        <>
          <span>
            {complete
              ? t('bulk.allMatchingSelected', { count: selectedCount })
              : t('bulk.someMatchingSelected', { count: selectedCount, total })}
          </span>
          <button
            type="button"
            onClick={onClear}
            className="font-semibold text-primary-600 hover:underline"
          >
            {t('bulk.clearSelection')}
          </button>
        </>
      ) : (
        <>
          <span>{t('bulk.allPageSelected', { count: pageCount })}</span>
          <button
            type="button"
            onClick={onSelectAll}
            disabled={selecting}
            className="font-semibold text-primary-600 hover:underline disabled:opacity-50"
          >
            {selecting ? t('bulk.selectingAll') : t('bulk.selectAllMatching', { count: total })}
          </button>
          {error && (
            <span aria-live="polite" className="text-[12px] font-medium text-rose-600">
              {error}
            </span>
          )}
        </>
      )}
    </div>
  );
}
