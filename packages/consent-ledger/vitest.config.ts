import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['src/__tests__/**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // logger.ts is a configuration shim with no logic to unit-test.
      exclude: ['src/__tests__/**', 'src/logger.ts'],
      thresholds: { lines: 70 },
    },
  },
});
