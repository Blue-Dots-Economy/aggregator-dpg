'use client';

/**
 * Profile-completion cell for the dashboard table (`web` app).
 */
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { useCellPopover } from './useCellPopover';

/** Completion (percent) shown in green and labelled complete. */
const COMPLETE_PCT = 80;

/** Completion (percent) shown in amber; below it the bar is red. */
const PARTIAL_PCT = 50;

/** Props for {@link ProgressTiny}. */
export interface ProgressTinyProps {
  pct: number;
  title?: string;
}

/**
 * Progress bar from `profile_completion_pct`.
 *
 * The popover shows the lifecycle label passed in `title`.
 */
export function ProgressTiny({ pct, title }: ProgressTinyProps) {
  const color = pct >= COMPLETE_PCT ? '#10B981' : pct >= PARTIAL_PCT ? '#F59E0B' : '#EF4444';
  const t = useTranslations('status_pill');
  const label = title ?? (pct >= COMPLETE_PCT ? t('complete') : t('incomplete'));
  const { ref, popoverRef, open, pos, triggerProps } = useCellPopover();
  return (
    <>
      <div
        ref={ref}
        {...triggerProps}
        className="flex items-center gap-2 cursor-default rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--bd-primary)"
      >
        <div
          role="progressbar"
          aria-label={label}
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="w-14 h-1.5 rounded-full bg-ink-100 overflow-hidden"
        >
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
        </div>
        <span className="text-[11px] tabular-nums text-ink-500 font-medium">{pct}%</span>
      </div>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            data-cell-popover=""
            style={{ position: 'absolute', left: pos.x, top: pos.y, zIndex: 9999 }}
            className="bg-white border border-(--bd-border) rounded-[10px] bd-shadow-lg px-2.5 py-1.5 max-w-[calc(100vw-1rem)] wrap-anywhere pointer-events-none animate-[fadeUp_.12s_ease-out]"
          >
            <div className="flex items-center gap-2 text-[12px] min-w-[120px]">
              <span className="text-ink-500 flex-1">{label}</span>
              <span className="font-semibold tabular-nums text-ink-900">{pct}%</span>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
