'use client';

/**
 * Initiated / Received action-funnel cell for the dashboard table (`web` app).
 */
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { FunnelPart } from '../_lib/funnel';
import { useCellPopover } from './useCellPopover';

/** Props for {@link FunnelCell}. */
export interface FunnelCellProps {
  total: number;
  parts: FunnelPart[];
}

/** Total with a stacked bar; the popover lists each part's count. */
export function FunnelCell({ total, parts }: FunnelCellProps) {
  const t = useTranslations('dashboard');
  const sum = parts.reduce((a, b) => a + b.v, 0) || 1;
  const { ref, popoverRef, open, pos, triggerProps } = useCellPopover();

  return (
    <>
      <div
        ref={ref}
        {...triggerProps}
        className="inline-flex items-center gap-2 cursor-default rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--bd-primary)"
      >
        <span className="font-display font-bold text-[18px] text-ink-900 tabular-nums leading-none">
          {total}
        </span>
        <div className="flex h-1 w-16 rounded-full overflow-hidden bg-ink-100">
          {parts.map((p) => (
            <div key={p.color} style={{ width: `${(p.v / sum) * 100}%`, background: p.color }} />
          ))}
        </div>
      </div>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            data-cell-popover=""
            style={{ position: 'absolute', left: pos.x, top: pos.y, zIndex: 9999 }}
            // max-w + wrap-anywhere keep the popover within the viewport.
            className="bg-white border border-(--bd-border) rounded-[10px] bd-shadow-lg p-2.5 min-w-[160px] max-w-[calc(100vw-1rem)] wrap-anywhere pointer-events-none animate-[fadeUp_.12s_ease-out]"
          >
            <div className="flex flex-col gap-1.5">
              {parts.map((p) => (
                <div key={p.color} className="flex items-center gap-2 text-[12px]">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
                  <span className="text-ink-500 flex-1">{p.label}</span>
                  <span className="font-semibold tabular-nums text-ink-900">{p.v}</span>
                </div>
              ))}
              <div className="border-t border-(--bd-border-soft) mt-1 pt-1.5 flex items-center gap-2 text-[12px]">
                <span className="text-ink-400 flex-1">{t('cell.total')}</span>
                <span className="font-display font-bold tabular-nums text-ink-900">{total}</span>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
