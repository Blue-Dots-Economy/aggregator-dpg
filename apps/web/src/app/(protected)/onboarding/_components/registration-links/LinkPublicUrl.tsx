'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useTranslations } from 'next-intl';
import { I } from '@/icons';
import { splitPublicUrl } from './link-form';
import { QrPreviewModal } from './QrPreviewModal';

/** How long the copy button shows its copied mark. */
const COPIED_MARK_MS = 1500;

/** QR image options: medium error correction, a one-module margin, print-sized width. */
const QR_OPTIONS = { errorCorrectionLevel: 'M', margin: 1, width: 512 } as const;

/** Props for {@link LinkPublicUrl}. */
export interface LinkPublicUrlProps {
  /** The live link's public URL. */
  publicUrl: string;
  /** Link slug, used for the downloaded QR file name. */
  slug: string;
}

/**
 * Public URL pill of a live link, with copy, QR preview and open actions.
 *
 * The QR is generated in the browser from the public URL when the preview opens.
 */
export function LinkPublicUrl({ publicUrl, slug }: Readonly<LinkPublicUrlProps>) {
  const t = useTranslations('onboarding');
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  // `<host>/<orgSlug>/<slug>`.
  const { host: urlHost, path: urlPath } = splitPublicUrl(publicUrl);

  // One copied-mark timer at a time, cleared on unmount.
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const onCopy = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
    } catch (err) {
      // The browser refused the write; the missing tick tells the user.
      console.warn('copy link failed', err);
      return;
    }
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MARK_MS);
  };

  const openQr = async () => {
    setQrError(null);
    setQrOpen(true);
    try {
      setQrDataUrl(await QRCode.toDataURL(publicUrl, QR_OPTIONS));
    } catch (err) {
      console.error('qr generation failed', err);
      setQrError(t('link_card.qr_error'));
    }
  };

  const downloadQr = () => {
    if (!qrDataUrl) return;
    const a = document.createElement('a');
    a.href = qrDataUrl;
    a.download = `qr-${slug}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <>
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <div className="inline-flex flex-wrap sm:flex-nowrap items-center gap-1 min-w-0 max-w-full bg-ink-50 border border-(--bd-border) rounded-[10px] px-3 py-1.5 text-[12.5px] font-mono">
          <span className="text-ink-500">{urlHost}/</span>
          {/* Below `sm` a long slug wraps inside the pill. */}
          <span className="min-w-0 wrap-anywhere text-amber-700 font-semibold">{urlPath}</span>
          <button
            type="button"
            onClick={onCopy}
            title={copied ? t('link_card.copied') : t('link_card.copy_title')}
            aria-label={t('link_card.copy_title')}
            className={`ml-1 shrink-0 ${copied ? 'text-emerald-600' : 'text-ink-400 hover:text-primary-600'}`}
          >
            {copied ? <I.check size={12} /> : <I.copy size={12} />}
          </button>
        </div>
        <button
          type="button"
          onClick={openQr}
          title={t('link_card.view_qr')}
          className="inline-flex items-center justify-center w-8 h-8 rounded-[10px] border border-(--bd-border) text-ink-500 hover:text-primary-600 hover:border-(--bd-primary-100)"
        >
          <I.qr size={14} />
        </button>
        <a
          href={publicUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={t('link_card.open_link')}
          className="inline-flex items-center justify-center w-8 h-8 rounded-[10px] border border-(--bd-border) text-ink-500 hover:text-primary-600 hover:border-(--bd-primary-100)"
        >
          <I.link size={14} />
        </a>
      </div>
      {qrOpen && (
        <QrPreviewModal
          title={t('link_card.qr_modal_title')}
          dataUrl={qrDataUrl}
          error={qrError}
          onDownload={downloadQr}
          onClose={() => setQrOpen(false)}
        />
      )}
    </>
  );
}
