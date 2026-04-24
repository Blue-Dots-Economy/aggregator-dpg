/**
 * Integration tests for PostgresDBService.transaction().
 *
 * Requires a running Postgres instance. Set DATABASE_URL env var before
 * running. Tests are skipped automatically when DATABASE_URL is absent.
 *
 * Run: DATABASE_URL=postgres://aggregator:aggregator@localhost:5432/aggregator_dev \
 *        pnpm --filter @aggregator-dpg/db test:integration
 *
 * @module @aggregator-dpg/db/__tests__
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresDBService } from '../postgres/index.js';
import type { DrizzleUoW } from '../postgres/uow.js';

const dbUrl = process.env['DATABASE_URL'];

const suite = dbUrl ? describe : describe.skip;

suite('PostgresDBService.transaction (integration)', () => {
  let svc: PostgresDBService;

  beforeAll(() => {
    svc = new PostgresDBService({
      url: dbUrl!,
      poolSize: 2,
      statementTimeoutMs: 5_000,
      healthcheckTimeoutMs: 3_000,
      migrationsTable: '__drizzle_migrations',
      ssl: false,
    });
  });

  afterAll(() => svc.close());

  it('resolves the callback return value on success (commit path)', async () => {
    const result = await svc.transaction(async () => 'committed');
    expect(result).toBe('committed');
  });

  it('re-throws and rolls back when callback throws', async () => {
    await expect(
      svc.transaction(async () => {
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');
  });

  it('uow has a unique transactionId per transaction', async () => {
    const ids = await Promise.all([
      svc.transaction(async (uow) => uow.transactionId),
      svc.transaction(async (uow) => uow.transactionId),
    ]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('uow exposes typed repo handles', async () => {
    await svc.transaction(async (uow) => {
      const typed = uow as DrizzleUoW;
      expect(typed.auditLog).toBeDefined();
      expect(typed.aggregatorProfile).toBeDefined();
      expect(typed.onboardingLink).toBeDefined();
      expect(typed.registrationRequest).toBeDefined();
      expect(typed.exportJob).toBeDefined();
      expect(typed.bulkUploadBatch).toBeDefined();
      expect(typed.bulkUploadRow).toBeDefined();
      expect(typed.aggregatorProfileSchema).toBeDefined();
    });
  });

  it('SAVEPOINT: nested transaction resolves without error', async () => {
    const result = await svc.transaction(async () => {
      const inner = await svc.transaction(async () => 'inner-ok');
      return `outer-ok:${inner}`;
    });
    expect(result).toBe('outer-ok:inner-ok');
  });

  it('SAVEPOINT: inner rollback does not abort outer transaction', async () => {
    const result = await svc.transaction(async () => {
      try {
        await svc.transaction(async () => {
          throw new Error('inner failure');
        });
      } catch {
        // inner rolled back to savepoint — outer continues
      }
      return 'outer-survived';
    });
    expect(result).toBe('outer-survived');
  });

  it('SAVEPOINT: inner and outer uow have different transactionIds', async () => {
    let outerTxId: string | undefined;
    let innerTxId: string | undefined;

    await svc.transaction(async (outerUow) => {
      outerTxId = outerUow.transactionId;
      await svc.transaction(async (innerUow) => {
        innerTxId = innerUow.transactionId;
      });
    });

    expect(outerTxId).toBeDefined();
    expect(innerTxId).toBeDefined();
    expect(outerTxId).not.toBe(innerTxId);
  });
});
