import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '../lib/providers';
import './globals.css';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';

/**
 * Generates the page metadata from the active aggregator config.
 *
 * Fetched server-side from the api at build/render time so the browser
 * tab title reflects whichever signalstack network this deployment is
 * bound to. Falls back to a generic title on fetch failure so a cold
 * boot before the api is healthy still renders something readable.
 */
export async function generateMetadata(): Promise<Metadata> {
  try {
    const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
    const res = await fetch(`${base}/v1/aggregator-config`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status}`);
    const cfg = (await res.json()) as {
      brand: { long_name: string; tagline?: string };
    };
    return {
      title: `${cfg.brand.long_name}`,
      description:
        cfg.brand.tagline ?? `${cfg.brand.long_name} — track every participant in your network.`,
      // Brand-coloured favicon. Served by `app/brand-icon/route.ts`
      // which re-tints the network-mark SVG to the active
      // `primary_color`. Pointed at via metadata so Next emits the
      // right <link rel="icon"> without needing a static
      // `app/icon.svg` (which would short-circuit the dynamic route).
      icons: { icon: { url: '/brand-icon', type: 'image/svg+xml' } },
    };
  } catch {
    const t = await getTranslations('metadata');
    return {
      title: t('title'),
      description: t('description'),
      icons: { icon: { url: '/brand-icon', type: 'image/svg+xml' } },
    };
  }
}

// Inline no-flash script: applies the stored theme mode to <html>
// before React hydrates so a dark-preferring user never sees a flash
// of the light theme. Default is light if no preference is stored.
const themeNoFlashScript = `
(function () {
  try {
    var mode = localStorage.getItem('bd:theme-mode');
    if (mode === 'dark') document.documentElement.classList.add('dark');
  } catch (_) {}
})();
`;

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
