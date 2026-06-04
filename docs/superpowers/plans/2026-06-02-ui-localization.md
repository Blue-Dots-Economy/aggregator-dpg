# UI Language Localization (i18n) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cookie-based, config-driven UI localization (English/Kannada/Hindi) to the `apps/web` Next.js portal using `next-intl`, translating UI chrome only.

**Architecture:** `next-intl` v3 in "no-i18n-routing" mode. Locale is carried in a `NEXT_LOCALE` cookie, resolved server-side (cookie → `Accept-Language` → `en`) in `src/i18n/request.ts`, and provided to the tree via `NextIntlClientProvider` in the root layout. Server components use `getTranslations()`, client components use `useTranslations()`. The language dropdown is rendered dynamically from `NEXT_PUBLIC_ENABLED_LANGUAGES` (the Next.js equivalent of Signals-DPG's `VITE_ENABLED_LANGUAGES`). RJSF schemas, API responses, and emails are NOT translated. No schema changes.

**Tech Stack:** Next.js 15 (App Router), React 18, TypeScript, `next-intl@^3.26.0`, Vitest 2 + Testing Library, Radix Select.

**Spec:** `docs/superpowers/specs/2026-06-02-ui-localization-design.md`
**Branch:** `feat/ui-localization` (already created from `feature`).

**Conventions in this repo (do not deviate):**
- Tests live in `apps/web/src/__tests__/...` mirroring the source path; runner is Vitest with `globals: true` (no need to import `describe/it/expect` — but existing tests do import them; follow suit). Import alias `@` → `apps/web/src`.
- Run a single package's tests with: `pnpm --filter @aggregator-dpg/web test -- <path>`.
- Conventional Commits; never `--no-verify`. Commit after each task.
- Coverage thresholds (web): lines 70, functions 70, branches 60, statements 70.

---

## File Structure

**Create:**
- `apps/web/src/i18n/config.ts` — locale constants, `isSupportedLocale`, `getEnabledLocales`, `resolveLocale` (pure helpers, fully unit-tested).
- `apps/web/src/i18n/request.ts` — `next-intl` `getRequestConfig` (reads cookie/header, loads messages).
- `apps/web/src/i18n/locale-cookie.ts` — `LOCALE_COOKIE` constant + `setLocale` server action.
- `apps/web/src/i18n/messages/en.json` — English source catalog.
- `apps/web/src/i18n/messages/kn.json` — Kannada catalog.
- `apps/web/src/i18n/messages/hi.json` — Hindi catalog.
- `apps/web/src/components/shell/LanguageSwitcher.tsx` — client dropdown.
- Tests: `apps/web/src/__tests__/i18n/config.test.ts`, `apps/web/src/__tests__/i18n/messages.test.ts`, `apps/web/src/__tests__/components/LanguageSwitcher.test.tsx`.

**Modify:**
- `apps/web/package.json` — add `next-intl`.
- `apps/web/next.config.ts` — wrap with `createNextIntlPlugin`.
- `apps/web/src/app/layout.tsx` — provider + `lang` + localized metadata.
- `apps/web/src/components/shell/Topbar.tsx` — mount switcher.
- `apps/web/src/app/(public)/layout.tsx` — mount switcher.
- Chrome-bearing views (Tasks 8–13): `LoginView.tsx`, `RegisterView.tsx`, `dashboard/page.tsx`, `Sidebar.tsx`, onboarding components, profile/public-registration views.
- `apps/web/.env.example` and `docker-compose.yml` (`web` service) — `NEXT_PUBLIC_ENABLED_LANGUAGES`.

---

## Task 1: Install next-intl + locale config helpers (TDD)

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/i18n/config.ts`
- Test: `apps/web/src/__tests__/i18n/config.test.ts`

- [ ] **Step 1: Add the dependency and install**

Edit `apps/web/package.json` — add to `dependencies` (keep alphabetical-ish, after `next`):

```json
    "next": "^15.1.4",
    "next-intl": "^3.26.0",
```

Run: `pnpm --filter @aggregator-dpg/web install`
Expected: `next-intl` resolved and added to the lockfile.

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/__tests__/i18n/config.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  isSupportedLocale,
  getEnabledLocales,
  resolveLocale,
} from '@/i18n/config';

const ENV_KEY = 'NEXT_PUBLIC_ENABLED_LANGUAGES';

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe('i18n config', () => {
  it('supports en, kn, hi with en as default', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'kn', 'hi']);
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('isSupportedLocale guards unknown/empty values', () => {
    expect(isSupportedLocale('kn')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale('')).toBe(false);
  });

  it('getEnabledLocales returns all supported when env unset', () => {
    expect(getEnabledLocales()).toEqual(['en', 'kn', 'hi']);
  });

  it('getEnabledLocales honours the env list and order, always including en', () => {
    process.env[ENV_KEY] = 'hi,kn';
    expect(getEnabledLocales()).toEqual(['en', 'hi', 'kn']);
  });

  it('getEnabledLocales drops unsupported codes and trims whitespace', () => {
    process.env[ENV_KEY] = 'en, fr , kn';
    expect(getEnabledLocales()).toEqual(['en', 'kn']);
  });

  it('resolveLocale prefers a valid enabled cookie', () => {
    expect(resolveLocale('hi', 'en-US,en;q=0.9')).toBe('hi');
  });

  it('resolveLocale negotiates from Accept-Language when no cookie', () => {
    expect(resolveLocale(undefined, 'kn-IN,kn;q=0.9,en;q=0.8')).toBe('kn');
  });

  it('resolveLocale falls back to default for unknown cookie + header', () => {
    expect(resolveLocale('fr', 'fr-FR,fr;q=0.9')).toBe('en');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web test -- src/__tests__/i18n/config.test.ts`
Expected: FAIL — cannot resolve `@/i18n/config`.

- [ ] **Step 4: Implement `config.ts`**

Create `apps/web/src/i18n/config.ts`:

```ts
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
  const ordered = requested.includes(DEFAULT_LOCALE)
    ? requested
    : [DEFAULT_LOCALE, ...requested];
  // de-dupe while preserving order
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @aggregator-dpg/web test -- src/__tests__/i18n/config.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/src/i18n/config.ts apps/web/src/__tests__/i18n/config.test.ts pnpm-lock.yaml
git commit -m "feat(web): add next-intl + i18n locale config helpers"
```

---

## Task 2: Seed message catalogs + key-parity test (TDD)

**Files:**
- Create: `apps/web/src/i18n/messages/en.json`, `kn.json`, `hi.json`
- Test: `apps/web/src/__tests__/i18n/messages.test.ts`

- [ ] **Step 1: Write the failing parity test**

Create `apps/web/src/__tests__/i18n/messages.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import en from '@/i18n/messages/en.json';
import kn from '@/i18n/messages/kn.json';
import hi from '@/i18n/messages/hi.json';

/** Recursively collects dotted key paths from a nested message object. */
function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v)
      ? keyPaths(v as Record<string, unknown>, path)
      : [path];
  });
}

describe('message catalogs', () => {
  const enKeys = keyPaths(en).sort();

  it('en has at least the seed namespaces', () => {
    expect(enKeys).toContain('language.label');
    expect(enKeys).toContain('metadata.title');
  });

  it('kn has exactly the same keys as en', () => {
    expect(keyPaths(kn).sort()).toEqual(enKeys);
  });

  it('hi has exactly the same keys as en', () => {
    expect(keyPaths(hi).sort()).toEqual(enKeys);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web test -- src/__tests__/i18n/messages.test.ts`
Expected: FAIL — cannot resolve `@/i18n/messages/en.json`.

> Note: importing `.json` in Vitest works out of the box. If TypeScript complains in the editor, `resolveJsonModule` is already enabled by the Next.js tsconfig; no change needed.

- [ ] **Step 3: Create the three seed catalogs**

Create `apps/web/src/i18n/messages/en.json`:

```json
{
  "language": { "label": "Language" },
  "metadata": {
    "title": "Aggregator Portal",
    "description": "Aggregator portal for signalstack-backed participant networks."
  },
  "common": {
    "back": "Back",
    "cancel": "Cancel",
    "continue": "Continue",
    "loading": "Loading…"
  }
}
```

Create `apps/web/src/i18n/messages/kn.json` (machine-translated first pass — refine later):

```json
{
  "language": { "label": "ಭಾಷೆ" },
  "metadata": {
    "title": "ಅಗ್ರಿಗೇಟರ್ ಪೋರ್ಟಲ್",
    "description": "ಸಿಗ್ನಲ್‌ಸ್ಟ್ಯಾಕ್ ಆಧಾರಿತ ಭಾಗವಹಿಸುವ ನೆಟ್‌ವರ್ಕ್‌ಗಳಿಗಾಗಿ ಅಗ್ರಿಗೇಟರ್ ಪೋರ್ಟಲ್."
  },
  "common": {
    "back": "ಹಿಂದೆ",
    "cancel": "ರದ್ದುಮಾಡಿ",
    "continue": "ಮುಂದುವರಿಸಿ",
    "loading": "ಲೋಡ್ ಆಗುತ್ತಿದೆ…"
  }
}
```

Create `apps/web/src/i18n/messages/hi.json` (machine-translated first pass — refine later):

```json
{
  "language": { "label": "भाषा" },
  "metadata": {
    "title": "एग्रीगेटर पोर्टल",
    "description": "सिग्नलस्टैक-समर्थित प्रतिभागी नेटवर्क के लिए एग्रीगेटर पोर्टल।"
  },
  "common": {
    "back": "वापस",
    "cancel": "रद्द करें",
    "continue": "जारी रखें",
    "loading": "लोड हो रहा है…"
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @aggregator-dpg/web test -- src/__tests__/i18n/messages.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/i18n/messages apps/web/src/__tests__/i18n/messages.test.ts
git commit -m "feat(web): seed en/kn/hi message catalogs with key-parity test"
```

---

## Task 3: Locale cookie action + request config

**Files:**
- Create: `apps/web/src/i18n/locale-cookie.ts`
- Create: `apps/web/src/i18n/request.ts`

> `request.ts` and `locale-cookie.ts` import `next/headers`, which can't run in jsdom unit tests. Their *logic* (negotiation/validation) lives in the pure `resolveLocale`/`isEnabledLocale` helpers already tested in Task 1. These two files are thin adapters verified by typecheck + the manual smoke at Task 7.

- [ ] **Step 1: Create the cookie action**

Create `apps/web/src/i18n/locale-cookie.ts`:

```ts
'use server';

import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, isEnabledLocale } from './config';

/** Cookie that carries the user's chosen UI locale. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

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
```

- [ ] **Step 2: Create the request config**

Create `apps/web/src/i18n/request.ts`:

```ts
import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { resolveLocale } from './config';
import { LOCALE_COOKIE } from './locale-cookie';

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
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @aggregator-dpg/web typecheck`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/i18n/locale-cookie.ts apps/web/src/i18n/request.ts
git commit -m "feat(web): add NEXT_LOCALE cookie action + next-intl request config"
```

---

## Task 4: Wire next-intl plugin + root layout provider

**Files:**
- Modify: `apps/web/next.config.ts`
- Modify: `apps/web/src/app/layout.tsx`

- [ ] **Step 1: Wrap next.config with the plugin**

Replace `apps/web/next.config.ts` with:

```ts
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: false,
};

export default withNextIntl(nextConfig);
```

- [ ] **Step 2: Provider + lang + localized metadata in the root layout**

Edit `apps/web/src/app/layout.tsx`:

Add imports at the top (below the existing imports):

```ts
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
```

In `generateMetadata`, replace the `catch` fallback block so the generic title/description come from the catalog:

```ts
  } catch {
    const t = await getTranslations('metadata');
    return {
      title: t('title'),
      description: t('description'),
      icons: { icon: { url: '/brand-icon', type: 'image/svg+xml' } },
    };
  }
```

Change `RootLayout` to async, read locale + messages, set `lang`, and wrap in the provider:

```tsx
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeNoFlashScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Typecheck + build**

Run: `pnpm --filter @aggregator-dpg/web typecheck`
Expected: PASS.

Run: `pnpm --filter @aggregator-dpg/web build`
Expected: build succeeds; no "missing i18n request configuration" error.

- [ ] **Step 4: Commit**

```bash
git add apps/web/next.config.ts apps/web/src/app/layout.tsx
git commit -m "feat(web): wire next-intl plugin + provider into root layout"
```

---

## Task 5: LanguageSwitcher component (TDD)

**Files:**
- Create: `apps/web/src/components/shell/LanguageSwitcher.tsx`
- Test: `apps/web/src/__tests__/components/LanguageSwitcher.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/components/LanguageSwitcher.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const refresh = vi.fn();
const setLocale = vi.fn().mockResolvedValue(undefined);

vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/i18n/locale-cookie', () => ({ setLocale }));

import { LanguageSwitcher } from '@/components/shell/LanguageSwitcher';

beforeEach(() => {
  refresh.mockClear();
  setLocale.mockClear();
  delete process.env.NEXT_PUBLIC_ENABLED_LANGUAGES;
});

describe('<LanguageSwitcher />', () => {
  it('renders a trigger labelled with the language label when >1 locale enabled', () => {
    render(<LanguageSwitcher />);
    expect(screen.getByLabelText('Language')).toBeInTheDocument();
  });

  it('renders nothing when fewer than two locales are enabled', () => {
    process.env.NEXT_PUBLIC_ENABLED_LANGUAGES = 'en';
    const { container } = render(<LanguageSwitcher />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

> The Radix `<Select>` portals its options on open; asserting option clicks in jsdom is brittle. We assert the visible trigger + the single-locale hide path. The cookie/refresh wiring is exercised by the manual smoke (Task 7).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web test -- src/__tests__/components/LanguageSwitcher.test.tsx`
Expected: FAIL — cannot resolve `@/components/shell/LanguageSwitcher`.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/shell/LanguageSwitcher.tsx`:

```tsx
'use client';

import { useTransition } from 'react';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Languages } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { getEnabledLocales, LOCALE_NAMES } from '../../i18n/config';
import { setLocale } from '../../i18n/locale-cookie';

/**
 * Dropdown that switches the UI language. Options are rendered dynamically
 * from `NEXT_PUBLIC_ENABLED_LANGUAGES`; selecting one persists the choice to
 * the NEXT_LOCALE cookie and refreshes the route so server components re-render
 * in the new language. Hidden when fewer than two languages are enabled.
 */
export function LanguageSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const enabled = getEnabledLocales();

  if (enabled.length < 2) return null;

  function handleChange(next: string) {
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });
  }

  return (
    <Select value={locale} onValueChange={handleChange}>
      <SelectTrigger
        aria-label={LOCALE_NAMES_LABEL}
        className="w-auto gap-1.5 px-2.5 py-2"
      >
        <Languages className="h-4 w-4 shrink-0 opacity-70" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {enabled.map((code) => (
          <SelectItem key={code} value={code}>
            {LOCALE_NAMES[code]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// The trigger's accessible name. Hardcoded English is intentional here only as
// the aria-label fallback would otherwise need a hook; replace with a t() call
// once this component is itself rendered under the provider in Task 6's smoke.
const LOCALE_NAMES_LABEL = 'Language';
```

> NOTE for the implementer: the test asserts `getByLabelText('Language')`. To keep the component fully localized, in Task 6 replace `LOCALE_NAMES_LABEL` with `useTranslations('language')` → `t('label')` and update the test's mock to provide that hook. For Task 5, the constant keeps the unit test isolated from the provider.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @aggregator-dpg/web test -- src/__tests__/components/LanguageSwitcher.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/shell/LanguageSwitcher.tsx apps/web/src/__tests__/components/LanguageSwitcher.test.tsx
git commit -m "feat(web): add config-driven LanguageSwitcher component"
```

---

## Task 6: Mount the switcher (Topbar + public layout) and localize its label

**Files:**
- Modify: `apps/web/src/components/shell/Topbar.tsx`
- Modify: `apps/web/src/app/(public)/layout.tsx`
- Modify: `apps/web/src/components/shell/LanguageSwitcher.tsx`
- Modify: `apps/web/src/__tests__/components/LanguageSwitcher.test.tsx`

- [ ] **Step 1: Localize the switcher's aria-label**

In `LanguageSwitcher.tsx`, add `import { useTranslations } from 'next-intl';`, remove the `LOCALE_NAMES_LABEL` constant, and inside the component:

```tsx
  const t = useTranslations('language');
```

Set the trigger prop to `aria-label={t('label')}`.

Update the test mock in `LanguageSwitcher.test.tsx`:

```tsx
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => (key === 'label' ? 'Language' : key),
}));
```

Run: `pnpm --filter @aggregator-dpg/web test -- src/__tests__/components/LanguageSwitcher.test.tsx`
Expected: PASS (still 2 tests).

- [ ] **Step 2: Mount in the Topbar (authenticated chrome)**

In `apps/web/src/components/shell/Topbar.tsx`, add `import { LanguageSwitcher } from './LanguageSwitcher';` and render it inside the right cluster, before the theme button:

```tsx
      <div className="flex items-center gap-2 shrink-0">
        {right}
        <LanguageSwitcher />
        <button
          type="button"
          onClick={toggle}
```

- [ ] **Step 3: Mount on public pages (login/register)**

Replace `apps/web/src/app/(public)/layout.tsx` body with a top-right switcher slot:

```tsx
import type { ReactNode } from 'react';
import { LanguageSwitcher } from '../../components/shell/LanguageSwitcher';

/**
 * Public-auth routes (`/login`, `/register`) ship a fixed light-theme
 * hero + card design. Wrap the subtree in `bd-public-light` so descendants
 * always read light-theme CSS variables, and expose the language switcher in
 * a top-right slot so users can choose a language before signing in.
 */
export default function PublicAuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bd-public-light relative">
      <div className="absolute right-4 top-4 z-10">
        <LanguageSwitcher />
      </div>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + run the full web test suite**

Run: `pnpm --filter @aggregator-dpg/web typecheck`
Expected: PASS.

Run: `pnpm --filter @aggregator-dpg/web test`
Expected: PASS (all suites green).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/shell/Topbar.tsx "apps/web/src/app/(public)/layout.tsx" apps/web/src/components/shell/LanguageSwitcher.tsx apps/web/src/__tests__/components/LanguageSwitcher.test.tsx
git commit -m "feat(web): mount LanguageSwitcher in topbar + public layout"
```

---

## Task 7: End-to-end smoke (manual, no code)

Verifies the infrastructure before bulk string extraction.

- [ ] **Step 1: Add the env var locally**

Append to `apps/web/.env.example` (and your local `.env`/compose env if running in Docker):

```bash
# Comma-separated UI languages shown in the switcher, in display order.
# Codes must match files in apps/web/src/i18n/messages/<code>.json. `en` is
# always included. Unset → all available languages are shown.
NEXT_PUBLIC_ENABLED_LANGUAGES=en,kn,hi
```

- [ ] **Step 2: Run the app and verify**

Run the web app (dev or the Docker stack). Confirm:
- The language switcher appears in the authenticated Topbar and on `/login`.
- Selecting Kannada/Hindi updates `language.label` and the page `<title>`/metadata immediately (route refresh), and `<html lang>` changes.
- Reload preserves the choice (cookie). Clearing the cookie falls back to the browser language, else English.
- Setting `NEXT_PUBLIC_ENABLED_LANGUAGES=en` (rebuild) hides the switcher.

- [ ] **Step 3: Commit the env doc**

```bash
git add apps/web/.env.example
git commit -m "docs(web): document NEXT_PUBLIC_ENABLED_LANGUAGES for i18n"
```

---

## String-extraction tasks (8–13): chrome only

**Shared pattern for every extraction task below.** For each component:

1. Add keys to `apps/web/src/i18n/messages/en.json` under the namespace named in the task, then add the **same keys** (machine-translated values) to `kn.json` and `hi.json`. The Task 2 parity test fails if any key is missing — run it after editing catalogs.
2. In a **client** component (`'use client'`), add `import { useTranslations } from 'next-intl';` and `const t = useTranslations('<namespace>');`, then replace literal strings with `t('key')`. For interpolation use ICU: `t('showing', { from, to, total })` against `"showing": "Showing {from}–{to} of {total}"`.
3. In a **server** component (`page.tsx` with no `'use client'`), use `const t = await getTranslations('<namespace>')` from `next-intl/server`.
4. **Do NOT** touch RJSF schema titles/placeholders/enums, API response strings, or values coming from `cfg.brand.*`/backend.
5. Run the file's existing tests (if any) + the parity test; fix assertions that hardcoded the old English (prefer asserting the rendered English value, which is unchanged for `en`).

**Worked example (apply this exact shape everywhere):**

```tsx
// before
<button type="submit">{submitting ? 'Submitting…' : 'Submit application'}</button>

// after — RegisterView.tsx, namespace "register"
const t = useTranslations('register');
<button type="submit">{submitting ? t('submitting') : t('submit')}</button>
```
```jsonc
// en.json → "register": { "submitting": "Submitting…", "submit": "Submit application" }
// kn.json → "register": { "submitting": "ಸಲ್ಲಿಸಲಾಗುತ್ತಿದೆ…", "submit": "ಅರ್ಜಿ ಸಲ್ಲಿಸಿ" }
// hi.json → "register": { "submitting": "सबमिट हो रहा है…", "submit": "आवेदन सबमिट करें" }
```

Commit after each task: `git commit -m "feat(web): localize <area> chrome strings"`.

### Task 8 — Auth (namespace `auth`)
**File:** `apps/web/src/app/(public)/login/LoginView.tsx` (client).
Extract: "Welcome back.", the sub-line "Sign in or register your organisation to get started.", card labels ("Existing user — Sign in", "Become a member"), the two card sub-labels (keep the `{brand}` interpolation: `t('existing_sub', { brand })`), the session-expired alert, the footer "By continuing you agree to the Privacy Policy and Terms." (split into `footer_prefix` / `privacy` / `terms`), and every value in the `humanizeError` map. Leave `{brand}` values (from config) as interpolated variables, not translated.

### Task 9 — Register chrome (namespace `register`)
**File:** `apps/web/src/app/(public)/register/RegisterView.tsx` (client).
Extract: the `headingTagline` ("Tell us about your organisation."), the success block ("Application received", "Reference ID:", the approval sentence with `{brand}`), error titles, the submit/submitting button, and the footer note. **Do NOT** extract `schema.title` (RJSF) or any field titles/placeholders — those come from the schema and stay English. For `humaniseValidationErrors`, localize only the template wording (e.g. `"{field} is required"`); the `{field}` value is the schema title and stays as-is.

### Task 10 — Dashboard (namespace `dashboard`)
**File:** `apps/web/src/app/(protected)/dashboard/page.tsx`.
First confirm whether the file is a client component; if it uses hooks/`'use client'`, use `useTranslations`, else `getTranslations`. Extract: `DEFAULT_BUCKET_LABELS`, `DEFAULT_STATUS_LABELS`, `STATUS_HINTS`, table headers ("Joined", "Profile Status", "Status", "Recommended Action", the seeker/provider "Participant"/"Provider" header), search placeholders, pagination ("Showing {from}–{to} of {total}"), and the Export/Refresh buttons incl. their busy states. **Do NOT** translate row data, IDs, or any value sourced from the API.

### Task 11 — Shell nav (namespace `nav`)
**File:** `apps/web/src/components/shell/Sidebar.tsx` (client).
Extract: nav labels ("My {brand}" via `t('my', { brand })`, "Onboarding", "Profile"), the "Overview" section header, the org footer label, and the sign-out button. Keep org name/initials (data) as-is.

### Task 12 — Onboarding (namespace `onboarding`)
**Files:** `apps/web/src/app/(protected)/onboarding/page.tsx` and `apps/web/src/app/(protected)/onboarding/_components/{RegistrationLinksSection,CSVUpload,StatStrip}.tsx`, plus `bulk-uploads/page.tsx` and `links/page.tsx`.
Extract section headings, the CSV-upload instructional copy and button labels, and stat-strip labels. Leave uploaded file names and API-returned counts as data.

### Task 13 — Profile + public registration chrome (namespace `profile`)
**Files:** `apps/web/src/app/(protected)/profile/page.tsx`, `ProfileEditView.tsx`, `complete/ProfileCompleteView.tsx`, and `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx`.
Extract page headings, status/empty-state copy, button labels, toasts. **Do NOT** extract RJSF schema field titles/placeholders (profile.v1 schema) — they stay English.

---

## Task 14: Locale-aware date formatting

**Files:**
- Modify: `apps/web/src/app/(protected)/dashboard/page.tsx` and any other site of `toLocaleDateString('en-IN', …)` (grep first).

- [ ] **Step 1: Find the call sites**

Run: `grep -rn "toLocaleDateString('en-IN'" apps/web/src`
Expected: a small list (dashboard page + `dashboard.service`).

- [ ] **Step 2: Use next-intl's formatter in components**

In a client component, replace with the active-locale formatter:

```tsx
import { useFormatter } from 'next-intl';
// inside component:
const format = useFormatter();
// before: new Date(created).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
// after:
format.dateTime(new Date(created), { day: '2-digit', month: 'short', year: 'numeric' });
```

For non-component utilities (e.g. `dashboard.service.ts`), pass the active locale in as a parameter from the caller and use `new Intl.DateTimeFormat(locale, opts).format(date)` rather than hardcoding `'en-IN'`. Do not import `next-intl` hooks into non-component modules.

- [ ] **Step 3: Typecheck + tests**

Run: `pnpm --filter @aggregator-dpg/web typecheck && pnpm --filter @aggregator-dpg/web test`
Expected: PASS. Update any test asserting an exact `en-IN` date string to use the locale-aware output or a regex.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): locale-aware date formatting"
```

---

## Task 15: Docker / env wiring + docs

**Files:**
- Modify: `docker-compose.yml` (`web` service)
- Modify: `apps/web/.env.example` (already added in Task 7)
- Modify: `README.md` or `apps/web` docs (short i18n note)

- [ ] **Step 1: Pass the env to the web image**

`NEXT_PUBLIC_*` is baked at build time. In `docker-compose.yml`, under the `web` service, add a build arg + runtime env mirroring how `NEXT_PUBLIC_API_URL` is handled. Add to the `web.environment:` block:

```yaml
      NEXT_PUBLIC_ENABLED_LANGUAGES: ${NEXT_PUBLIC_ENABLED_LANGUAGES:-en,kn,hi}
```

If `apps/web/Dockerfile` consumes `NEXT_PUBLIC_*` as build `ARG`s (check it — `NEXT_PUBLIC_API_URL` pattern), add a matching `ARG NEXT_PUBLIC_ENABLED_LANGUAGES` and `ENV` line, and a `build.args` entry in compose. If the Dockerfile reads them from the environment at build, just the env line above suffices.

- [ ] **Step 2: Document it**

Add a short note (where the README documents env/i18n or in `apps/web`): the i18n approach (next-intl, cookie-based), how to add a language (drop `messages/<code>.json`, add the code to `SUPPORTED_LOCALES` + `LOCALE_NAMES`, list it in `NEXT_PUBLIC_ENABLED_LANGUAGES`), and the chrome-only scope.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml README.md
git commit -m "chore(web): wire NEXT_PUBLIC_ENABLED_LANGUAGES into compose + docs"
```

---

## Task 16: Final verification

- [ ] **Step 1: Whole-repo gates**

Run each and confirm PASS:
```bash
pnpm --filter @aggregator-dpg/web lint
pnpm --filter @aggregator-dpg/web typecheck
pnpm --filter @aggregator-dpg/web test
pnpm --filter @aggregator-dpg/web build
pnpm dep-check
```

- [ ] **Step 2: Coverage check**

Run: `pnpm --filter @aggregator-dpg/web test:coverage`
Expected: thresholds met (lines 70 / functions 70 / branches 60 / statements 70). The pure `config.ts` is fully covered by Task 1.

- [ ] **Step 3: Manual locale sweep**

With `NEXT_PUBLIC_ENABLED_LANGUAGES=en,kn,hi`, switch through all three languages and confirm chrome strings change while RJSF form fields and dashboard data remain English.

- [ ] **Step 4: Final commit (if anything outstanding)**

```bash
git add -A
git commit -m "test(web): final i18n verification pass"
```

---

## Self-Review notes (author)

- **Spec coverage:** library/approach (Tasks 1,3,4) ✓; cookie carrier (Task 3) ✓; config-driven dynamic switcher via `NEXT_PUBLIC_ENABLED_LANGUAGES` (Tasks 1,5,15) ✓; en/kn/hi catalogs + parity test (Task 2) ✓; switcher in topbar + public pages (Task 6) ✓; chrome-only extraction incl. explicit RJSF/API exclusions (Tasks 8–13) ✓; locale-aware dates (Task 14) ✓; no schema changes (stated in Tasks 9,13) ✓; tests incl. key-parity + getEnabledLocales + switcher (Tasks 1,2,5) ✓.
- **Naming consistency:** `setLocale`, `LOCALE_COOKIE='NEXT_LOCALE'`, `getEnabledLocales`, `isEnabledLocale`, `resolveLocale`, `SUPPORTED_LOCALES`, `LOCALE_NAMES` used consistently across tasks.
- **No blockers.** Extraction tasks 8–13 are mechanical applications of one worked pattern; each lists exact files, namespace, and the in/out-of-scope rule.
