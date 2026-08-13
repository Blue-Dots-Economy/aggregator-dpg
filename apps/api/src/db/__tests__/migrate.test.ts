/**
 * Unit tests for the migration runner (`runMigrations`).
 *
 * `drizzle-orm/node-postgres/migrator`'s `migrate()` is mocked (per
 * testing-requirements.md — no real DB/network calls in unit tests) so these
 * tests exercise the real folder-resolution / logging / error-propagation
 * logic in `migrate.ts` without touching a live database.
 *
 * The `isMain` CLI-entrypoint block (`if (isMain) { runMigrations()... }`) is
 * intentionally left uncovered: it only runs when this file is executed
 * directly as `node migrate.js` (`import.meta.url === file://${process.argv[1]}`),
 * which is never true under the Vitest runner (`process.argv[1]` is the
 * Vitest binary) — there is no way to exercise it as a unit test without
 * spawning a real child process, which would cross into integration-test
 * territory (real DB env vars) that this app deliberately keeps out of
 * `pnpm -w test`.
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const migrateMock = vi.fn();

vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: (...args: unknown[]) => migrateMock(...args),
}));

import { closeDb } from '../client.js';
import { runMigrations } from '../migrate.js';

afterEach(async () => {
  migrateMock.mockReset();
  await closeDb().catch(() => undefined);
});

describe('runMigrations', () => {
  it('resolves the migrations folder relative to this module and calls migrate()', async () => {
    migrateMock.mockResolvedValueOnce(undefined);

    await runMigrations();

    expect(migrateMock).toHaveBeenCalledTimes(1);
    const [dbArg, options] = migrateMock.mock.calls[0] as [unknown, { migrationsFolder: string }];
    expect(dbArg).toBeDefined();
    expect(options.migrationsFolder.replace(/\\/g, '/')).toMatch(
      /\/apps\/api\/drizzle\/migrations$/,
    );
  });

  it('propagates a rejection from migrate() to the caller', async () => {
    migrateMock.mockRejectedValueOnce(new Error('migration failed: relation already exists'));

    await expect(runMigrations()).rejects.toThrow('migration failed: relation already exists');
  });
});
