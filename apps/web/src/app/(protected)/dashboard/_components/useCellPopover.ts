'use client';

/**
 * Open and position state for the dashboard's table-cell popovers (`web` app).
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

/** Minimum distance (px) kept between a cell popover and the viewport edge. */
const POPOVER_GUTTER = 8;

/** Gap (px) between the cell's bottom edge and the popover. */
const POPOVER_OFFSET = 8;

/** How far (px) a cell may move before a scroll event closes the popover. */
const POPOVER_SCROLL_TOLERANCE = 2;

/** Checks whether a click came from a mouse; a tap or keyboard click has another pointer type. */
function isMouseClick(e: ReactMouseEvent): boolean {
  const native = e.nativeEvent;
  return 'pointerType' in native && native.pointerType === 'mouse';
}

/**
 * Open and position state for the portal popovers on table cells (FunnelCell, ProgressTiny).
 *
 * Opens on hover for mouse, on tap for touch, and on focus for keyboard;
 * Escape closes it. A layout effect places it beside its cell, at least
 * {@link POPOVER_GUTTER} from the viewport edge, before paint. A scroll closes
 * it only when the cell moved.
 *
 * @returns The trigger ref, the popover ref, open flag, page-relative position
 *   and the props to spread onto the trigger element.
 */
export function useCellPopover() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; placed: boolean }>({
    x: 0,
    y: 0,
    placed: false,
  });
  const ref = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // Viewport position of the cell when the popover opened (scroll-move check).
  const anchorRef = useRef<{ left: number; top: number } | null>(null);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    anchorRef.current = { left: r.left, top: r.top };
    setPos({ x: window.scrollX, y: r.bottom + window.scrollY + POPOVER_OFFSET, placed: false });
    setOpen(true);
  };
  const hide = () => setOpen(false);

  useLayoutEffect(() => {
    if (!open || pos.placed) return;
    const trigger = ref.current?.getBoundingClientRect();
    const popover = popoverRef.current?.getBoundingClientRect();
    if (!trigger || !popover) return;
    const maxLeft = Math.max(POPOVER_GUTTER, window.innerWidth - popover.width - POPOVER_GUTTER);
    const left = Math.min(Math.max(trigger.left, POPOVER_GUTTER), maxLeft);
    setPos((p) => ({ ...p, x: left + window.scrollX, placed: true }));
  }, [open, pos.placed]);

  // Close on a scroll that moves the cell. Capture phase also catches element scrolls.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => {
      const r = ref.current?.getBoundingClientRect();
      const a = anchorRef.current;
      if (
        !r ||
        !a ||
        Math.abs(r.left - a.left) > POPOVER_SCROLL_TOLERANCE ||
        Math.abs(r.top - a.top) > POPOVER_SCROLL_TOLERANCE
      ) {
        setOpen(false);
      }
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open]);

  const triggerProps = {
    tabIndex: 0,
    onPointerEnter: (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse') show();
    },
    onPointerLeave: (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse') hide();
    },
    onClick: (e: ReactMouseEvent) => {
      // Mouse opened it on hover; a click must not close it.
      if (isMouseClick(e)) return;
      if (open) hide();
      else show();
    },
    onFocus: (e: ReactFocusEvent<HTMLDivElement>) => {
      // Only keyboard focus opens it; a tap opens it through the click.
      if (e.currentTarget.matches(':focus-visible')) show();
    },
    onBlur: hide,
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key === 'Escape') hide();
    },
  };

  return { ref, popoverRef, open, pos, triggerProps };
}
