'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { I } from '@/icons';
import { useIsClient } from '@/hooks/useIsClient';

/** How long a success toast stays on screen; long enough to read one short sentence. */
const TOAST_VISIBLE_MS = 2400;

/** Props for {@link SuccessToast}. */
export interface SuccessToastProps {
  message: string;
  /** Called once the toast has been shown for `TOAST_VISIBLE_MS`. */
  onDone: () => void;
}

/**
 * Top-right success toast, rendered in a portal on <body>.
 *
 * Closes itself `TOAST_VISIBLE_MS` after it mounts. A parent re-render does
 * not restart the timer; give it a new `key` to show a new message.
 */
export function SuccessToast({ message, onDone }: Readonly<SuccessToastProps>) {
  const isClient = useIsClient();
  // The latest callback, so a new function from the parent does not restart the timer.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  useEffect(() => {
    const timer = setTimeout(() => onDoneRef.current(), TOAST_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!isClient) return null;
  return createPortal(
    <output
      aria-live="polite"
      className="fixed top-4 left-4 right-4 sm:left-auto z-100 rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700 shadow-lg inline-flex items-center gap-2"
    >
      <I.check size={14} /> {message}
    </output>,
    document.body,
  );
}
