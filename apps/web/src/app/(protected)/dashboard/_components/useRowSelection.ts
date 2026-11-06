'use client';

/**
 * Row selection for the dashboard table (`web` app).
 */
import { useState } from 'react';
import type { ParticipantBase } from '@/types';
import { isSelectableRow } from '../_lib/rows';

interface Selection {
  /** Selected rows by id, kept as full row data so bulk actions work across pages. */
  rows: ReadonlyMap<string, ParticipantBase>;
  /** True after "Select all N matching" selected every matching row. */
  allMatching: boolean;
}

const EMPTY_SELECTION: Selection = { rows: new Map(), allMatching: false };

/**
 * Selected rows of the dashboard table.
 *
 * The selection is kept across page changes and cleared when `filterKey` changes.
 *
 * @param filterKey - Identifies the active filters; a new value clears the selection.
 * @returns The selection and the actions that change it.
 */
export function useRowSelection(filterKey: string) {
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [selectionFilterKey, setSelectionFilterKey] = useState(filterKey);
  // Clear during render when the filters change, so no stale selection is drawn.
  if (selectionFilterKey !== filterKey) {
    setSelectionFilterKey(filterKey);
    setSelection(EMPTY_SELECTION);
  }

  const toggleRow = (row: ParticipantBase) => {
    setSelection((prev) => {
      const rows = new Map(prev.rows);
      if (rows.has(row.id)) rows.delete(row.id);
      else rows.set(row.id, row);
      // Any single change ends "all matching" mode.
      return { rows, allMatching: false };
    });
  };

  const selectRows = (pageRows: ParticipantBase[]) => {
    setSelection((prev) => {
      const rows = new Map(prev.rows);
      for (const r of pageRows) rows.set(r.id, r);
      return { rows, allMatching: false };
    });
  };

  const selectAllMatching = (allRows: ParticipantBase[]) => {
    const rows = new Map<string, ParticipantBase>();
    for (const r of allRows) if (isSelectableRow(r)) rows.set(r.id, r);
    setSelection({ rows, allMatching: true });
  };

  const clear = () => setSelection(EMPTY_SELECTION);

  return {
    selected: selection.rows,
    selectedAllMatching: selection.allMatching,
    toggleRow,
    selectRows,
    selectAllMatching,
    clear,
  };
}
