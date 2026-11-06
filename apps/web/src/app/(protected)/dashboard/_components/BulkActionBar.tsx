'use client';

/**
 * Bulk action bar for selected dashboard rows (`web` app).
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { I } from '@/icons';
import { useCan } from '@/lib/auth-context';
import { DASHBOARD_BULK_ACTIONS, type BulkAction } from '@/services/bulk-actions';
import type { ParticipantBase } from '@/types';

/** How long (ms) the success or failure notice stays visible. */
const NOTICE_DISMISS_MS = 4000;

/** Props for {@link BulkActionBar}. */
export interface BulkActionBarProps {
  selectedRows: ParticipantBase[];
  domain: string;
  onClear: () => void;
}

/**
 * Action bar shown above the table while rows are selected.
 *
 * Renders one button per {@link BulkAction} in `DASHBOARD_BULK_ACTIONS` the user may run.
 */
export function BulkActionBar({ selectedRows, domain, onClear }: BulkActionBarProps) {
  const t = useTranslations('dashboard');
  const can = useCan();
  const [runningId, setRunningId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // Each notice hides after NOTICE_DISMISS_MS; the timer is cleared on a new notice or unmount.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const runAction = async (action: BulkAction) => {
    if (runningId) return;
    setRunningId(action.id);
    setNotice(null);
    try {
      await action.run(selectedRows, { domain });
      setNotice({ kind: 'success', text: t('bulk.success', { count: selectedRows.length }) });
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : t('bulk.failed'),
      });
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div className="px-5 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-(--bd-border) bg-(--bd-primary-50)">
      <span className="text-[12.5px] font-semibold text-primary-600 whitespace-nowrap">
        {t('bulk.selected', { count: selectedRows.length })}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {DASHBOARD_BULK_ACTIONS.filter((a) => can(a.capability)).map((a) => {
          const Ic = I[a.icon];
          return (
            <Button
              key={a.id}
              kind="ghost"
              icon={<Ic size={13} />}
              onClick={() => void runAction(a)}
              disabled={runningId !== null}
              className="whitespace-nowrap px-3 py-1.5 text-[12.5px]"
            >
              {runningId === a.id ? t('bulk.running') : t(a.labelKey)}
            </Button>
          );
        })}
      </div>
      {notice && (
        <span
          aria-live="polite"
          className={`text-[12px] font-medium truncate ${
            notice.kind === 'success' ? 'text-emerald-700' : 'text-rose-600'
          }`}
        >
          {notice.text}
        </span>
      )}
      <button
        type="button"
        onClick={onClear}
        className="ml-auto text-[12px] font-semibold text-ink-500 hover:text-ink-700 whitespace-nowrap"
      >
        {t('bulk.clear')}
      </button>
    </div>
  );
}
