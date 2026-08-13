import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // schema-types.ts is a pure `export type` re-export module (zero
      // runtime statements after erasure) — same rationale as excluding
      // *.d.ts, just not literally a .d.ts file.
      exclude: ['src/__tests__/**', 'src/schema-types.ts'],
      thresholds: { lines: 70 },
    },
  },
});
