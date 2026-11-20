'use client';

/**
 * Under-18 notice of the two-option public registration page (web app,
 * public registration). Tells a minor to register on the Signals app with a
 * parent or guardian, counts down, then opens the Signals page in this tab.
 */

import { useEffect, useState, type JSX } from 'react';
import { useTranslations } from 'next-intl';

/** Seconds before the page moves on: long enough to read the two-sentence notice. */
export const MINOR_REDIRECT_SECONDS = 10;

/** Props of {@link MinorRedirectNotice}. */
export interface MinorRedirectNoticeProps {
  /** The Signals page to open, or null when none is configured (the notice then stays). */
  url: string | null;
  /** Opens a URL in this tab; the page passes its logging navigation helper. */
  navigate: (url: string) => void;
}

/**
 * Renders the under-18 notice as a toast and opens `url` when the count ends.
 *
 * The parent unmounts it when the birth year changes to an adult's, which
 * stops the countdown.
 *
 * @param props - The Signals URL and the navigation helper.
 * @returns The notice.
 */
export function MinorRedirectNotice({
  url,
  navigate,
}: Readonly<MinorRedirectNoticeProps>): JSX.Element {
  const t = useTranslations('profile.public_reg.minor');
  const [seconds, setSeconds] = useState(MINOR_REDIRECT_SECONDS);

  useEffect(() => {
    if (!url) return;
    if (seconds <= 0) {
      navigate(url);
      return;
    }
    const timer = setTimeout(() => setSeconds((prev) => prev - 1), 1000);
    return () => clearTimeout(timer);
  }, [url, seconds, navigate]);

  return (
    <div
      role="status"
      data-testid="minor-redirect-notice"
      className="fixed inset-x-4 bottom-6 z-50 mx-auto max-w-[520px] rounded-[14px] border border-amber-200 bg-white px-5 py-4 shadow-[0_20px_60px_-20px_rgba(11,16,32,0.35)]"
    >
      <div className="font-display font-bold text-[15px] text-ink-900">{t('title')}</div>
      <p className="mt-1 text-[13.5px] text-ink-700 leading-relaxed">
        {url ? t('body') : t('body_no_link')}
      </p>
      {url ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span aria-hidden="true" className="text-[12.5px] text-ink-500">
            {t('countdown', { seconds: Math.max(seconds, 0) })}
          </span>
          <button
            type="button"
            onClick={() => navigate(url)}
            className="rounded-[10px] bg-(--bd-primary-600) px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90"
          >
            {t('go_now')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
