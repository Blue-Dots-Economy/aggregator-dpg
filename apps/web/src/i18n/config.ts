/**
 * Locale constants and pure resolution helpers for the web portal's i18n.
 *
 * Kept free of `next/*` imports so it is unit-testable and importable from
 * both server and client code. The active set of switchable languages is
 * driven by `NEXT_PUBLIC_ENABLED_LANGUAGES` (Next.js equivalent of
 * Signals-DPG's `VITE_ENABLED_LANGUAGES`).
 */

export const SUPPORTED_LOCALES = ['en', 'kn', 'hi'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Native display name per locale, shown in the language switcher. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  kn: 'ಕನ್ನಡ',
  hi: 'हिन्दी',
};

/** Type guard: is `v` one of the supported locale codes. */
export function isSupportedLocale(v: string | undefined | null): v is Locale {
  return !!v && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

/**
 * Locales shown in the switcher, derived from `NEXT_PUBLIC_ENABLED_LANGUAGES`
 * (comma-separated, ordered). `en` is always force-included as the fallback.
 * Unsupported codes are dropped. Unset env → all supported locales.
 */
export function getEnabledLocales(): Locale[] {
  const raw = process.env.NEXT_PUBLIC_ENABLED_LANGUAGES;
  if (!raw) return [...SUPPORTED_LOCALES];
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Locale => isSupportedLocale(s));
  const ordered = requested.includes(DEFAULT_LOCALE) ? requested : [DEFAULT_LOCALE, ...requested];
  const seen = new Set<Locale>();
  const result = ordered.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
  return result.length > 0 ? result : [...SUPPORTED_LOCALES];
}

/** True when `v` is supported AND enabled for this deployment. */
export function isEnabledLocale(v: string | undefined | null): v is Locale {
  return isSupportedLocale(v) && getEnabledLocales().includes(v);
}

/**
 * Resolves the active locale from a cookie value and an Accept-Language
 * header. Cookie wins when it names an enabled locale; otherwise the first
 * Accept-Language tag whose base matches an enabled locale; otherwise the
 * default. Pure — no `next/*` access — so it is unit-testable.
 *
 * @param cookieValue - The locale cookie value, if present.
 * @param acceptLanguage - The Accept-Language header string, or null.
 * @returns The resolved locale code.
 */
export function resolveLocale(
  cookieValue: string | undefined,
  acceptLanguage: string | null,
): Locale {
  if (isEnabledLocale(cookieValue)) return cookieValue;
  const tags = (acceptLanguage ?? '')
    .split(',')
    .map((t) => t.split(';')[0]?.trim().toLowerCase())
    .filter((t): t is string => Boolean(t));
  for (const tag of tags) {
    const base = tag.split('-')[0];
    if (isEnabledLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
