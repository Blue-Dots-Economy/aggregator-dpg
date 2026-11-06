'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { I } from '@/icons';
import { useIsClient } from '@/hooks/useIsClient';

/** How long the upload toast stays on screen; long enough to read two sentences. */
const UPLOAD_TOAST_VISIBLE_MS = 6000;

/** Props for {@link UploadToast}. */
export interface UploadToastProps {
  message: string;
  /** Called `UPLOAD_TOAST_VISIBLE_MS` after the toast mounts or `onDone` changes. */
  onDone: () => void;
}

/** Top-right success toast for an upload, rendered in a portal on <body>. */
export function UploadToast({ message, onDone }: Readonly<UploadToastProps>) {
  const isClient = useIsClient();
  useEffect(() => {
    const timer = setTimeout(onDone, UPLOAD_TOAST_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [onDone]);
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
