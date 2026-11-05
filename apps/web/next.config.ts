import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: false,
  // pino-pretty runs in a worker thread that thread-stream loads by file path.
  // Bundled, that path does not exist, so these load from node_modules.
  serverExternalPackages: ['pino', 'pino-pretty', 'thread-stream'],
};

export default withNextIntl(nextConfig);
