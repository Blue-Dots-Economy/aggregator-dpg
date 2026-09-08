/**
 * Locale constants and pure resolution helpers for the web portal's i18n.
 *
 * Kept free of `next/*` imports so it is unit-testable and importable from
 * both server and client code. The active set of switchable languages is
 * driven by `ENABLED_LANGUAGES`.
 *
 * `getEnabledLocales()` reads `process.env`, so it must only be called where
 * that is a RUNTIME read — server components, server actions and route
 * handlers. Client components take the resolved list from
 * `EnabledLocalesProvider` instead; see the note on that function.
 */

export const SUPPORTED_LOCALES = ['en', 'kn', 'hi'] as const;

/** Cookie name that carries the user's chosen UI locale. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';
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
 * Parses a comma-separated, ordered locale list into the set shown in the
 * switcher. `en` is always force-included as the fallback, unsupported codes
 * are dropped, and duplicates collapse. Empty/absent input → all supported
 * locales.
 *
 * Pure, so the same rules apply whether the raw value came from the
 * environment (server) or was handed to a client component as a prop.
 *
 * @param raw - Comma-separated locale codes, or undefined when unconfigured.
 * @returns The enabled locales, in display order.
 */
export function parseEnabledLocales(raw: string | undefined | null): Locale[] {
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

/**
 * Locales shown in the switcher, from the `ENABLED_LANGUAGES` environment
 * variable.
 *
 * SERVER-ONLY in effect. Next.js inlines `process.env.NEXT_PUBLIC_*` into the
 * client bundle at `next build`, so the previous `NEXT_PUBLIC_`-prefixed name
 * read from a client component froze the language list into the image — the
 * var looked configurable but needed a rebuild to change, which is no use to
 * an operator. The unprefixed name is read per request on the server instead,
 * and the resolved list reaches client components through
 * `EnabledLocalesProvider`.
 *
 * `NEXT_PUBLIC_ENABLED_LANGUAGES` is still honoured as a fallback so existing
 * deployments keep working through the rename; remove it once they have moved.
 *
 * @returns The enabled locales, in display order.
 */
export function getEnabledLocales(): Locale[] {
  return parseEnabledLocales(
    process.env.ENABLED_LANGUAGES ?? process.env.NEXT_PUBLIC_ENABLED_LANGUAGES,
  );
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
