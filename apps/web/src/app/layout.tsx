import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '../lib/providers';
import './globals.css';

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
    return {
      title: 'Aggregator Portal',
      description: 'Aggregator portal for signalstack-backed participant networks.',
      icons: { icon: { url: '/brand-icon', type: 'image/svg+xml' } },
    };
  }
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
