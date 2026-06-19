import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { resolveLocale, LOCALE_COOKIE } from './config';

/**
 * Server-side per-request i18n config for next-intl (no-routing mode).
 *
 * Resolves the active locale from the NEXT_LOCALE cookie, falling back to the
 * Accept-Language header and then the default, and loads that locale's message
 * catalog.
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const locale = resolveLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get('accept-language'),
  );
  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
