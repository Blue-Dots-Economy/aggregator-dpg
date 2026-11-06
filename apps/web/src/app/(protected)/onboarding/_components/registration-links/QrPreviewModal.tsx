'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { I } from '@/icons';

/** Props for {@link QrPreviewModal}. */
export interface QrPreviewModalProps {
  title: string;
  /** PNG data URI generated in the browser; `null` while generating. */
  dataUrl: string | null;
  /** Set when generation failed. */
  error: string | null;
  onDownload: () => void;
  onClose: () => void;
}

/**
 * QR preview modal with a Download action, rendered as a native <dialog>.
 *
 * The caller generates the PNG data URI in the browser.
 */
export function QrPreviewModal({
  title,
  dataUrl,
  error,
  onDownload,
  onClose,
}: Readonly<QrPreviewModalProps>) {
  const t = useTranslations('onboarding');
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Native <dialog> gives focus trapping, focus restore, and Esc-to-close.
  useEffect(() => {
    const el = dialogRef.current;
    el?.showModal?.();
    return () => el?.close?.();
  }, []);

  let body: ReactNode;
  if (error) {
    body = <p className="text-[13px] text-rose-600">{error}</p>;
  } else if (dataUrl) {
    // A data: URI made in the browser; next/image has nothing to fetch or optimise.
    // eslint-disable-next-line @next/next/no-img-element
    body = <img src={dataUrl} alt={title} className="h-52 w-52" />;
  } else {
    body = <p className="text-[13px] text-ink-400">{t('link_card.qr_generating')}</p>;
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      onClose={onClose}
      className="m-auto w-full max-w-[340px] rounded-[14px] bg-white p-5 shadow-xl backdrop:bg-black/40"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-[15px] font-bold text-ink-900">{title}</h3>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label={t('link_card.qr_close')}
          className="text-ink-400 hover:text-ink-700"
        >
          <I.x size={16} />
        </button>
      </div>
      <div className="flex min-h-[220px] items-center justify-center rounded-[10px] border border-(--bd-border) bg-ink-50 p-4">
        {body}
      </div>
      <div className="mt-4">
        <button
          type="button"
          onClick={onDownload}
          disabled={!dataUrl}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-primary-600 px-3 py-2 text-[13px] font-semibold text-white hover:bg-primary-700 disabled:opacity-50"
        >
          <I.download size={14} /> {t('link_card.qr_download')}
        </button>
      </div>
    </dialog>
  );
}
