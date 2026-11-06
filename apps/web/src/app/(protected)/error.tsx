'use client';

/**
 * Shown when a coordinator portal page fails to render: a plain message with
 * a retry and a link to the dashboard, inside the portal layout.
 * It covers the pages under this group, not the group's layout.
 *
 * The error's message and digest are never shown or logged here, because
 * they can carry upstream details. Next.js logs server errors on the server.
 */

import { useTranslations } from 'next-intl';
import { PageError } from '@/components/ui/PageError';

export default function ProtectedError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  const t = useTranslations('page_error');
  const copy = { title: t('title'), body: t('body'), retry: t('retry') };
  return <PageError copy={copy} home={{ href: '/dashboard', label: t('home') }} reset={reset} />;
}
