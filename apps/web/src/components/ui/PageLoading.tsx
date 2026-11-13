/**
 * Loading status for a route segment whose page reads data on the server.
 * Used by `loading.tsx` files so the layout stays visible while the page
 * renders.
 */

import { useTranslations } from 'next-intl';

/** Renders the translated loading text as a polite status message. */
export function PageLoading() {
  const t = useTranslations('common');
  return (
    <p role="status" className="py-10 text-center text-[13.5px] text-ink-400">
      {t('loading')}
    </p>
  );
}
