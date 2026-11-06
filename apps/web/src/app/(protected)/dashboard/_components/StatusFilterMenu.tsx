'use client';

/**
 * Status filter button and menu for the dashboard table (`web` app).
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { I } from '@/icons';
import type { StatusFilter, StatusOption } from '../_lib/status';

/** Props for {@link StatusFilterMenu}. */
export interface StatusFilterMenuProps {
  value: StatusFilter;
  options: StatusOption[];
  onChange?: ((next: StatusFilter) => void) | undefined;
}

/**
 * Button that opens a menu of statuses; picking one calls `onChange` and closes it.
 *
 * A `mousedown` outside the menu closes it.
 */
export function StatusFilterMenu({ value, options, onChange }: StatusFilterMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const filterActive = value !== 'all';

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        e.target instanceof Node &&
        !containerRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={containerRef} className="relative ml-auto sm:ml-0">
      <Button
        kind={filterActive ? 'primary' : 'ghost'}
        icon={<I.filter size={14} />}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="whitespace-nowrap px-3 py-1.5 text-[12.5px]"
      >
        {filterActive
          ? (options.find((o) => o.value === value)?.label ?? 'Filtered')
          : 'All filters'}
      </Button>
      {open && (
        <div
          role="menu"
          // Max height with its own scroll so every option stays reachable.
          className="absolute right-0 top-full mt-1 z-20 min-w-[180px] max-w-[calc(100vw-2rem)] max-h-[min(320px,60vh)] overflow-y-auto bg-white border border-(--bd-border) rounded-[10px] bd-shadow-lg p-1"
        >
          {options.map((opt) => {
            const active = value === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onChange?.(opt.value);
                  setOpen(false);
                }}
                className={`w-full text-left px-2.5 py-1.5 rounded-md text-[12.5px] flex items-center justify-between ${
                  active
                    ? 'bg-(--bd-primary-50) text-primary-600 font-semibold'
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
  );
}
