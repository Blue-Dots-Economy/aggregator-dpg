'use client';

/**
 * Shown when a coordinator portal page fails to render: a plain message with
 * a retry and a link to the dashboard, inside the portal layout.
 *
 * The error's message and digest are never shown or logged here, because
 * they can carry upstream details. Next.js logs server errors on the server.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CircleAlert } from 'lucide-react';
import { buttonClass } from '@/components/ui/button-class';

export default function ProtectedError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  const t = useTranslations('page_error');
  return (
    <section className="bd-card bd-shadow mx-auto mt-10 flex max-w-lg flex-col items-center gap-3 px-6 py-10 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-rose-50 text-rose-600">
        <CircleAlert size={22} aria-hidden="true" />
      </span>
      <h1 className="font-display text-[20px] font-bold text-ink-900">{t('title')}</h1>
      <p className="text-[14px] text-ink-500">{t('body')}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <button type="button" className={buttonClass('primary')} onClick={reset}>
          {t('retry')}
        </button>
        <Link className={buttonClass('ghost')} href="/dashboard">
          {t('home')}
        </Link>
      </div>
    </section>
  );
}
