import { describe, expect, it } from 'vitest';
// next.config.ts is outside src/, so the @/ alias cannot reach it.
// eslint-disable-next-line no-restricted-imports
import nextConfig from '../../../next.config';

describe('next.config', () => {
  it('loads the logger packages from node_modules, so the pino-pretty worker resolves under next dev', () => {
    expect(nextConfig.serverExternalPackages).toEqual(
      expect.arrayContaining(['pino', 'pino-pretty', 'thread-stream']),
    );
  });
});
