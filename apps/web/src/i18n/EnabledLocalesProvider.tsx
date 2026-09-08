'use client';

/**
 * Carries the runtime-resolved enabled-locale list across the server/client
 * boundary for the web portal's i18n.
 *
 * Exists because `ENABLED_LANGUAGES` must stay a RUNTIME setting. A client
 * component cannot read it: Next.js only exposes `NEXT_PUBLIC_*` to the
 * browser, and those are inlined at `next build`, so reading the list in the
 * language switcher baked it into the image and made the var require a rebuild
 * to change. The root layout is a server component, every route nests under
 * it, and it already establishes a client boundary for `next-intl` — so it
 * resolves the list once per request and publishes it here.
 *
 * Consumers outside a provider fall back to English only, so a mis-wired
 * subtree hides the switcher rather than offering a disabled language.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_LOCALE, type Locale } from './config';

const EnabledLocalesContext = createContext<readonly Locale[] | null>(null);

/**
 * Fallback when no provider is above the consumer: English only.
 *
 * Chosen over "every supported locale" because that would offer languages the
 * deployment had switched off, and over throwing because a missing provider is
 * not a fatal condition — every route nests under the root layout that supplies
 * one, and the server-side `isEnabledLocale` check rejects a disabled locale
 * anyway. English-only degrades to hiding the switcher (it needs two or more
 * locales to render), which is the conservative end of the behaviour.
 */
const FALLBACK_LOCALES: readonly Locale[] = [DEFAULT_LOCALE];

/**
 * Publishes the enabled locales to client components.
 *
 * @param value - The resolved locales, from `getEnabledLocales()` on the server.
 * @param children - Subtree that may call `useEnabledLocales`.
 */
export function EnabledLocalesProvider({
  value,
  children,
}: Readonly<{ value: readonly Locale[]; children: ReactNode }>) {
  return (
    <EnabledLocalesContext.Provider value={value}>{children}</EnabledLocalesContext.Provider>
  );
}

/**
 * The enabled locales, as resolved on the server for this request.
 *
 * @returns The enabled locales in display order, or `['en']` when no provider
 *   is present — see `FALLBACK_LOCALES`.
 */
export function useEnabledLocales(): readonly Locale[] {
  return useContext(EnabledLocalesContext) ?? FALLBACK_LOCALES;
}
