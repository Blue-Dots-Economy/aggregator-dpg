'use client';

/**
 * Shown when a console page fails to load: a plain message with a retry and
 * a way back, instead of the framework's error screen.
 */

import { useTranslations } from 'next-intl';
import { PageError } from '@/components/ui/PageError';

export default function ConsoleError({ reset }: Readonly<{ error: Error; reset: () => void }>) {
  const t = useTranslations('console.page_error');
  const copy = { title: t('title'), body: t('body'), retry: t('retry'), home: t('home') };
  return <PageError copy={copy} homeHref="/console" reset={reset} />;
}
