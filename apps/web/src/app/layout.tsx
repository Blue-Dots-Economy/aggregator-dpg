import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '../lib/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Blue Dots — Aggregator Portal',
  description:
    'Track every participant in your network — at a glance. Blue Dots Aggregator Portal.',
};

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
