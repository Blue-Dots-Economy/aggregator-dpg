'use client';

import { useEffect, useRef, type JSX } from 'react';
import type { SubmitError } from '../_lib/use-registration-submit';

/**
 * Error banner above the form. Each new error scrolls the banner into view
 * and focuses it.
 */
export function SubmitErrorBanner({ error }: Readonly<{ error: SubmitError }>): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ref.current?.focus();
  }, [error]);

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="mb-5 rounded-[10px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700 scroll-mt-6 outline-hidden"
    >
      <div className="font-semibold">{error.title}</div>
      <div className="mt-1 text-rose-600">{error.detail}</div>
      {error.code !== 'UNKNOWN' && (
        <div className="mt-2 text-[11px] text-rose-500/80 font-mono">Code: {error.code}</div>
      )}
    </div>
  );
}
