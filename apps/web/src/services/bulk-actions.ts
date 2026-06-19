/**
 * Bulk-action registry for the dashboard participant table. The selection
 * layer (checkboxes in `ParticipantTable`) knows nothing about what actions
 * exist; the bulk bar renders whatever {@link BulkAction} descriptors it is
 * given. Adding a future bulk action means appending one descriptor here
 * (plus, for server actions, extending the BFF allowlist).
 *
 * @module apps/web/services/bulk-actions
 */

import type { IconName } from '../icons';
import type { ParticipantBase } from '../types';
import { dashboardService } from './dashboard.service';
import { triggerCsvDownload } from './dashboard.service';
import { buildParticipantCsv } from './participant-csv';

/** Context the bulk bar passes to every action run. */
export interface BulkActionContext {
  /** Signalstack domain id the table is showing (e.g. `seeker`). */
  domain: string;
}

/**
 * One bulk action the operator can run on the current selection.
 *
 * `kind` is informational — `'client'` actions complete entirely in the
 * browser, `'server'` actions round-trip through the BFF. The bar treats
 * both identically (await `run`, then show success/error).
 */
export interface BulkAction {
  /** Stable key; for server actions this is also the BFF action name. */
  id: string;
  /** `dashboard.bulk.*` i18n key for the button label. */
  labelKey: string;
  icon: IconName;
  kind: 'client' | 'server';
  /**
   * Executes the action against the selected rows.
   *
   * @param rows - Snapshot of the selected rows (may span pages).
   * @param ctx - Domain context for server calls / filenames.
   * @throws When the action fails — the bar surfaces the message inline.
   */
  run(rows: ParticipantBase[], ctx: BulkActionContext): Promise<void>;
}

/**
 * The default bulk actions shipped with the dashboard:
 * 1. `export_selected_csv` — client-side CSV of the selected rows only
 *    (decoupled from the signalstack-owned full export).
 * 2. `trigger_callback` — 202-stub POST to `/api/dashboard/actions`; real
 *    delivery lands when the callback service exists.
 */
export const DASHBOARD_BULK_ACTIONS: BulkAction[] = [
  {
    id: 'export_selected_csv',
    labelKey: 'bulk.exportSelected',
    icon: 'download',
    kind: 'client',
    run: async (rows, ctx) => {
      const csv = buildParticipantCsv(rows);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const date = new Date().toISOString().slice(0, 10);
      triggerCsvDownload({ blob, filename: `dashboard-${ctx.domain}-selected-${date}.csv` });
    },
  },
  {
    id: 'trigger_callback',
    labelKey: 'bulk.triggerCallback',
    icon: 'phone',
    kind: 'server',
    run: async (rows, ctx) => {
      await dashboardService.dashboardBulkAction({
        action: 'trigger_callback',
        domain: ctx.domain,
        ids: rows.map((r) => r.id),
      });
    },
  },
];
