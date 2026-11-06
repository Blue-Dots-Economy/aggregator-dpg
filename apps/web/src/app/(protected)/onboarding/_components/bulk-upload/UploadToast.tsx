'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { I } from '@/icons';
import { useIsClient } from '@/hooks/useIsClient';

/** How long the upload toast stays on screen; long enough to read one short sentence. */
const UPLOAD_TOAST_VISIBLE_MS = 2500;

/** Props for {@link UploadToast}. */
export interface UploadToastProps {
  message: string;
  /** Called once the toast has been shown for `UPLOAD_TOAST_VISIBLE_MS`. */
  onDone: () => void;
}

/**
 * Top-right success toast for an upload, rendered in a portal on <body>.
 *
 * Closes itself `UPLOAD_TOAST_VISIBLE_MS` after it mounts. A parent re-render
 * does not restart the timer, and unmounting cancels it.
 */
export function UploadToast({ message, onDone }: Readonly<UploadToastProps>) {
  const isClient = useIsClient();
  // The latest callback, so a new function from the parent does not restart the timer.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  useEffect(() => {
    const timer = setTimeout(() => onDoneRef.current(), UPLOAD_TOAST_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!isClient) return null;
  return createPortal(
    <output
      aria-live="polite"
      className="fixed top-4 left-4 right-4 sm:left-auto z-100 sm:max-w-sm rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700 shadow-lg inline-flex items-start gap-2"
    >
      <I.check size={14} className="mt-0.5 shrink-0" /> <span>{message}</span>
    </output>,
    document.body,
  );
}
