# UI Language Localization (i18n) — aggregator-dpg web

**Date:** 2026-06-02
**Status:** Design — pending implementation
**Target app:** `apps/web` (Next.js 15 App Router)
**Reference:** Signals-DPG `localization` branch (used for inspiration only; this app uses a different, App-Router-correct approach)

---

## 1. Goal

The aggregator portal currently renders only English. Add UI language
localization so the **app's own interface text** can be shown in
**English, Kannada, and Hindi**, with a language switcher and a remembered
choice. English is the source language and the fallback.

### Non-goals (explicitly out of scope)

- **No translation of API responses or backend data.** i18n libraries only
  swap statically-authored UI strings from our own message catalogs; they do
  not translate dynamic data. Dashboard rows, profile values, signalstack
  responses, etc. render exactly as the backend returns them.
- **No translation of the RJSF form schemas.** The registration and profile
  forms are driven by `config/schemas/aggregator/*.json`. Their field
  `title`, `ui:placeholder`, and `ui:enumNames` stay in their schema English.
  (Same scope decision Signals-DPG made.)
- **No backend / email localization.** API emails (approval, welcome, OTP)
  are unchanged.
- **No locale-prefixed URLs** (`/hi/...`) and **no locale routing/middleware**.
- **No persistence of the language choice to the user profile / DB.** The
  choice lives in a cookie only.

---

## 2. Approach decision

### Library: `next-intl` (not a literal port of Signals-DPG)

Signals-DPG is a Vite React SPA and used client-only `react-i18next` +
`i18next-browser-languagedetector`. That is correct for an SPA but is **not**
the idiomatic choice for the Next.js App Router, because:

- It cannot localize **Server Components** (`layout.tsx`, the `page.tsx`
  wrappers, `generateMetadata`) — only `'use client'` components.
- It renders English on the server, then swaps on the client (a first-paint
  flash requiring a mount-gate workaround).
- `<html lang>` and page metadata stay English.

`next-intl` is the standard App-Router i18n library. It is **server-first**:
the correct language is rendered on the server, works in **both** server and
client components, produces no flash, sets a correct `<html lang>` and
localized metadata, and uses ICU message format (correct plurals / number /
date formatting).

The translation **scope is identical** to the Signals-DPG approach (UI chrome
only). `next-intl` does not add API/backend translation work — it simply does
the same job the architecturally-correct way.

### Locale carrier: cookie-based, no URL routing

`next-intl` supports either locale-prefixed routes (`/en`, `/hi`, with
middleware) or carrying the locale outside the URL. This app is primarily
behind authentication (no SEO need) plus a public registration page (mild SEO
value). We use the **cookie-based mode**:

- Locale stored in a `NEXT_LOCALE` cookie.
- Detection order: `NEXT_LOCALE` cookie → `Accept-Language` request header →
  default (`en`).
- **No route restructuring** (the existing `(public)` / `(protected)` route
  groups and the `[org]/[slug]` dynamic route are untouched) and **no internal
  link/redirect rewrites**.

Locale-prefixed routing can be added later if a public-SEO requirement
appears; it is intentionally deferred to avoid restructuring the whole route
tree and rewriting every redirect/link for an auth-gated app.

### Supported languages

`en` (source + fallback), `kn` (ಕನ್ನಡ), `hi` (हिन्दी). Kannada and Hindi
message files are machine-translated as a first pass and can be refined by a
translator later.

### Config-driven, dynamic switcher (core requirement)

Which languages appear in the switcher is **driven by an env variable and the
dropdown renders dynamically from it** — mirroring Signals-DPG's
`VITE_ENABLED_LANGUAGES` behavior. The Next.js equivalent must use the
`NEXT_PUBLIC_` prefix to be browser-readable:

```
NEXT_PUBLIC_ENABLED_LANGUAGES=en,kn,hi
```

- Comma-separated language codes, in display order.
- `en` is always included (fallback safety).
- If unset, all available message files are shown (dev convenience).
- The switcher maps each enabled code → its native name and renders the
  options dynamically — adding/removing a code changes the dropdown with no
  code edits.

See §6 for details.

---

## 3. Architecture

### 3.1 New files

```
apps/web/src/i18n/
├── config.ts            # SUPPORTED_LOCALES, DEFAULT_LOCALE, localeNames, isSupportedLocale()
├── request.ts           # next-intl getRequestConfig: resolves locale + loads messages
├── locale-cookie.ts     # cookie name constant + server action setLocale()
└── messages/
    ├── en.json          # source of truth (all chrome strings)
    ├── kn.json          # machine-translated first pass
    └── hi.json          # machine-translated first pass
apps/web/src/components/shell/LanguageSwitcher.tsx   # client <Select>, sets cookie + refresh
```

### 3.2 Modified files

| File | Change |
|---|---|
| `apps/web/package.json` | add `next-intl` dependency |
| `apps/web/next.config.ts` | wrap config with `createNextIntlPlugin('./src/i18n/request.ts')` |
| `apps/web/src/app/layout.tsx` | `lang={locale}` from `getLocale()`; wrap body in `NextIntlClientProvider`; localize `generateMetadata` strings |
| `apps/web/src/lib/providers.tsx` | (only if provider nesting needs adjustment; `NextIntlClientProvider` lives in root layout) |
| `apps/web/src/components/shell/Topbar.tsx` | render `<LanguageSwitcher />` next to the theme toggle (authenticated) |
| `apps/web/src/app/(public)/layout.tsx` | render `<LanguageSwitcher />` in a small top-right slot (public pages) |
| `apps/web/src/app/[org]/[slug]/…` | ensure the public registration page exposes the switcher |
| chrome-bearing components/views (see §4) | replace hardcoded English with `t(...)` calls |
| `apps/web/.env.example` | document optional `NEXT_PUBLIC_ENABLED_LANGUAGES` (see §6) |
| `docker-compose.yml` (`web` service) | pass the enabled-languages env if used at build time |

### 3.3 `config.ts`

```ts
export const SUPPORTED_LOCALES = ['en', 'kn', 'hi'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  kn: 'ಕನ್ನಡ',
  hi: 'हिन्दी',
};
export function isSupportedLocale(v: string | undefined): v is Locale {
  return !!v && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

/**
 * Enabled locales for the switcher, derived from NEXT_PUBLIC_ENABLED_LANGUAGES
 * (comma-separated, ordered). `en` is always included. Falls back to all
 * SUPPORTED_LOCALES when the env var is unset. Mirrors Signals-DPG's
 * VITE_ENABLED_LANGUAGES toggle.
 */
export function getEnabledLocales(): Locale[] {
  const raw = process.env.NEXT_PUBLIC_ENABLED_LANGUAGES;
  if (!raw) return [...SUPPORTED_LOCALES];
  const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = requested.filter(isSupportedLocale);
  const withFallback = valid.includes(DEFAULT_LOCALE) ? valid : [DEFAULT_LOCALE, ...valid];
  return withFallback.length > 0 ? withFallback : [...SUPPORTED_LOCALES];
}
```

### 3.4 `request.ts` (server-side locale resolution + message load)

```ts
import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { DEFAULT_LOCALE, isSupportedLocale, SUPPORTED_LOCALES } from './config';
import { LOCALE_COOKIE } from './locale-cookie';

function negotiate(acceptLanguage: string | null): string {
  // pick the first Accept-Language tag whose base matches a supported locale
  // (lightweight matcher; @formatjs/intl-localematcher optional)
  ...
}

export default getRequestConfig(async () => {
  const cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isSupportedLocale(cookieLocale)
    ? cookieLocale
    : (negotiate((await headers()).get('accept-language')) ?? DEFAULT_LOCALE);
  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
```

### 3.5 `locale-cookie.ts` (cookie name + server action)

```ts
'use server';
import { cookies } from 'next/headers';
import { isSupportedLocale, DEFAULT_LOCALE } from './config';

export const LOCALE_COOKIE = 'NEXT_LOCALE';

export async function setLocale(next: string): Promise<void> {
  const value = isSupportedLocale(next) ? next : DEFAULT_LOCALE;
  (await cookies()).set(LOCALE_COOKIE, value, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365, // 1 year
    sameSite: 'lax',
  });
}
```

### 3.6 Root layout wiring

```tsx
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  // …fetch brand as today, fall back to t('title')/t('description')…
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>{/* unchanged: no-flash theme script + fonts */}</head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
```

### 3.7 LanguageSwitcher (client)

```tsx
'use client';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { setLocale } from '@/i18n/locale-cookie';
import { getEnabledLocales, LOCALE_NAMES } from '@/i18n/config';
// reuse existing components/ui/select

export function LanguageSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const enabled = getEnabledLocales(); // dynamic, from NEXT_PUBLIC_ENABLED_LANGUAGES
  if (enabled.length < 2) return null;  // hide when only one language is enabled
  return (
    <Select value={locale} onValueChange={(next) =>
      start(async () => { await setLocale(next); router.refresh(); })
    }>
      {/* trigger w/ Languages icon + value; items from enabled.map(c => LOCALE_NAMES[c]) */}
    </Select>
  );
}
```

### 3.8 Component usage

- **Client components** (the interactive views — `LoginView`, `RegisterView`,
  dashboard, `Sidebar`, `Topbar`, onboarding, profile views): `useTranslations('ns')`.
- **Server components** (`page.tsx` wrappers, `generateMetadata`): `await getTranslations('ns')`.

---

## 4. String extraction (chrome only)

Replace hardcoded English with namespaced `t()` keys. Namespaces:
`common`, `auth`, `register`, `dashboard`, `nav`, `onboarding`, `profile`,
`errors`, `language`, `theme`, `metadata`.

In scope:

- `(public)/login/LoginView.tsx` — headings, taglines, card labels, footer
  (Privacy/Terms), the `humanizeError` map.
- `(public)/register/RegisterView.tsx` — page chrome: heading tagline,
  "Application received" success block, error titles, submit/footer copy, and
  the `humaniseValidationErrors` template text. **The RJSF schema field titles
  themselves stay English.**
- `(protected)/dashboard/page.tsx` — bucket/status labels, status hints,
  table headers, search placeholders, pagination ("Showing X–Y of Z"),
  Export/Refresh buttons.
- `components/shell/Sidebar.tsx` — nav labels, "Overview", org footer label,
  sign-out.
- `components/shell/Topbar.tsx` — theme toggle title/aria-label.
- `(protected)/onboarding/*` and `_components/*` — section headings, CSV
  upload copy, stat labels.
- `(protected)/profile/*` view chrome and `[org]/[slug]` public-registration
  view chrome.
- Toasts, empty states, `aria-label`s encountered in the above.

Out of scope (stay English): RJSF schema `title` / `ui:placeholder` /
`ui:enumNames`; field names echoed inside validation messages (they originate
from the schema).

### Dates

The hardcoded `toLocaleDateString('en-IN', …)` calls become locale-aware via
`next-intl`'s `useFormatter()` / `getFormatter()` (`format.dateTime(...)`),
using the active locale. (Small, included.)

---

## 5. Message file format

Nested JSON namespaces, ICU message syntax. `en.json` is the source of truth;
`kn.json` and `hi.json` carry the same key tree.

```jsonc
// en.json (excerpt)
{
  "common":   { "back": "Back", "cancel": "Cancel", "continue": "Continue" },
  "auth":     { "welcome_back": "Welcome back.", "existing_user": "Existing user — Sign in" },
  "dashboard":{ "export_csv": "Export CSV", "showing": "Showing {from}–{to} of {total}" },
  "language": { "label": "Language" },
  "metadata": { "title": "Aggregator Portal", "description": "Aggregator portal for signalstack-backed participant networks." }
}
```

---

## 6. Configuration

`SUPPORTED_LOCALES` is a code-level constant in `i18n/config.ts` (it is tied to
which message files physically exist).

**`NEXT_PUBLIC_ENABLED_LANGUAGES` is a core requirement** (the Next.js
equivalent of Signals-DPG's `VITE_ENABLED_LANGUAGES`). It gates which of the
supported locales appear in the switcher and the dropdown is rendered
**dynamically** from it via `getEnabledLocales()` (§3.3):

- Comma-separated codes, in display order, e.g. `NEXT_PUBLIC_ENABLED_LANGUAGES=en,kn,hi`.
- `en` is always force-included as the fallback.
- Unset → all `SUPPORTED_LOCALES` are shown (dev convenience).
- Codes not present in `SUPPORTED_LOCALES` (no message file) are ignored.

Because `NEXT_PUBLIC_*` is **baked into the client bundle at build time**, it
must be supplied as a build arg/env on the `web` image:

- `apps/web/.env.example` — documented with the example value.
- `docker-compose.yml` `web` service — passed through (build arg + runtime
  env), the same way `NEXT_PUBLIC_API_URL` is handled today, so a VM rebuild
  picks it up.

`request.ts` also validates the cookie/negotiated locale against the **enabled**
set (not just the supported set), so a stale cookie for a now-disabled language
falls back cleanly to `en`.

---

## 7. Testing (Vitest, per project rules)

- **Locale resolution** (`request.ts` helper): cookie wins; absent cookie →
  `Accept-Language` negotiation; unsupported/none → `DEFAULT_LOCALE`.
- **`isSupportedLocale`** edge cases (undefined, empty, unknown).
- **`getEnabledLocales`** (config-driven dropdown): parses
  `NEXT_PUBLIC_ENABLED_LANGUAGES` in order, always includes `en`, drops
  unsupported codes, and falls back to all supported when unset.
- **LanguageSwitcher**: renders exactly one option per **enabled** locale (per
  the env list); hides itself when fewer than two are enabled; selecting one
  calls `setLocale` then `router.refresh()`.
- **Render test**: a component wrapped in `NextIntlClientProvider` with each
  locale's messages renders the translated string; missing key falls back to
  English.
- **Key-parity test**: every key path in `en.json` exists in `kn.json` and
  `hi.json` (and no extras) — guards against drift as strings are added.
- No real network / DB. Target ≥ 70% line coverage for the new modules.

---

## 8. Rollout / branch

- Implementation on a new branch **`feature/ui-localization`** cut from the
  current `feature` branch.
- Suggested phasing: (1) install + config + provider + switcher + `en.json`
  scaffolding and wire one view end-to-end; (2) extract strings area-by-area
  into `en.json`; (3) generate `kn.json` / `hi.json`; (4) tests + key-parity;
  (5) docker-compose env wiring + docs.

---

## 9. Open questions

None blocking. Confirmed decisions:

- **Scope = UI chrome only.** RJSF form-field labels/placeholders/enums and all
  dynamic/backend data stay English. **No schema changes** to
  `config/schemas/aggregator/*`.
- **Config-driven, dynamic switcher** via `NEXT_PUBLIC_ENABLED_LANGUAGES` —
  core requirement (Next.js equivalent of `VITE_ENABLED_LANGUAGES`).
- locale-aware dates = yes; switcher on public login/register pages = yes.
