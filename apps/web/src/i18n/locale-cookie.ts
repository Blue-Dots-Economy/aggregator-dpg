'use server';

import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, isEnabledLocale, LOCALE_COOKIE } from './config';

/**
 * Persists the chosen UI locale to the `NEXT_LOCALE` cookie.
 *
 * Invoked from the language switcher. Falls back to the default locale if
 * the requested value is not an enabled locale, so a tampered value can never
 * pin the UI to an unsupported language.
 *
 * @param next - Requested locale code.
 */
export async function setLocale(next: string): Promise<void> {
  const value = isEnabledLocale(next) ? next : DEFAULT_LOCALE;
  (await cookies()).set(LOCALE_COOKIE, value, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
}
