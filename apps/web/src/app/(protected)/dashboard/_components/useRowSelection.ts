'use client';

/**
 * Row selection for the dashboard table (`web` app).
 */
import { useState } from 'react';
import type { ParticipantBase } from '@/types';
import { isSelectableRow } from '../_lib/rows';

interface Selection {
  /** The filters this selection belongs to. */
  filterKey: string;
  /** Selected rows by id, kept as full row data so bulk actions work across pages. */
  rows: ReadonlyMap<string, ParticipantBase>;
  /**
   * Set after "Select all N matching". `complete` is false when fewer rows
   * were read than matched.
   */
  matching: { complete: boolean } | null;
  /** Message of the last failed "Select all N matching". */
  error: string | null;
}

function emptySelection(filterKey: string): Selection {
  return { filterKey, rows: new Map(), matching: null, error: null };
}

/**
 * Selected rows of the dashboard table.
 *
 * The selection is kept across page changes and cleared when `filterKey` changes.
 * A select-all result or failure for an older `filterKey` is dropped.
 *
 * @param filterKey - Identifies the active filters; a new value clears the selection.
 * @returns The selection and the actions that change it.
 */
export function useRowSelection(filterKey: string) {
  const [selection, setSelection] = useState<Selection>(() => emptySelection(filterKey));
  // Clear during render when the filters change, so no stale selection is drawn.
  if (selection.filterKey !== filterKey) {
    setSelection(emptySelection(filterKey));
  }

  const toggleRow = (row: ParticipantBase) => {
    setSelection((prev) => {
      const rows = new Map(prev.rows);
      if (rows.has(row.id)) rows.delete(row.id);
      else rows.set(row.id, row);
      // Any single change ends "all matching" mode.
      return { ...prev, rows, matching: null, error: null };
    });
  };

  const selectRows = (pageRows: ParticipantBase[]) => {
    setSelection((prev) => {
      const rows = new Map(prev.rows);
      for (const r of pageRows) rows.set(r.id, r);
      return { ...prev, rows, matching: null, error: null };
    });
  };

  /**
   * Replaces the selection with every selectable matching row.
   *
   * @param allRows - The rows read for the filters in `forFilterKey`.
   * @param complete - Whether every matching row was read.
   * @param forFilterKey - The filters the read was made for.
   */
  const selectAllMatching = (
    allRows: ParticipantBase[],
    complete: boolean,
    forFilterKey: string,
  ) => {
    const rows = new Map<string, ParticipantBase>();
    for (const r of allRows) if (isSelectableRow(r)) rows.set(r.id, r);
    setSelection((prev) =>
      prev.filterKey === forFilterKey
        ? { filterKey: forFilterKey, rows, matching: { complete }, error: null }
        : prev,
    );
  };

  /**
   * Records a failed "Select all N matching"; the selection is unchanged.
   *
   * @param message - Text to show.
   * @param forFilterKey - The filters the read was made for.
   */
  const failSelectAll = (message: string, forFilterKey: string) => {
    setSelection((prev) => (prev.filterKey === forFilterKey ? { ...prev, error: message } : prev));
  };

  const clear = () => setSelection((prev) => emptySelection(prev.filterKey));

  return {
    selected: selection.rows,
    selectedAllMatching: selection.matching !== null,
    matchingComplete: selection.matching?.complete ?? false,
    selectAllError: selection.error,
    toggleRow,
    selectRows,
    selectAllMatching,
    failSelectAll,
    clear,
  };
}
