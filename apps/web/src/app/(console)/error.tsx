'use client';

/**
 * Shown when the console layout fails, for example when the API is down and
 * the signed-in user cannot be read. The boundary in `console/` covers the
 * pages only, so this one sits above the console layout.
 *
 * It renders without the console sidebar and offers a retry only, because
 * every console link goes through the same layout. The error's message and
 * digest are never shown here; Next.js logs server errors on the server.
 */

import { useTranslations } from 'next-intl';
import { PageError } from '@/components/ui/PageError';

export default function ConsoleLayoutError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  const t = useTranslations('console.unavailable');
  const copy = { title: t('title'), body: t('body'), retry: t('retry') };
  return (
    <main className="min-h-dvh px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <PageError copy={copy} reset={reset} />
    </main>
  );
}
