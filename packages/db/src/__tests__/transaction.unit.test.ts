/**
 * Unit tests for withTransaction() — verifies SAVEPOINT nesting detection
 * via AsyncLocalStorage without requiring a real Postgres connection.
 *
 * @module @aggregator-dpg/db/__tests__
 */

import { describe, it, expect, vi } from 'vitest';
import { withTransaction } from '../postgres/transaction.js';
import type { DrizzleDB } from '../postgres/drizzle.js';

function makeMockDb() {
  const mockTx = {
    transaction: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const mockDb = {
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockTx)),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  mockTx.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockTx));

  return { mockDb: mockDb as unknown as DrizzleDB, mockTx };
}

describe('withTransaction — SAVEPOINT nesting', () => {
  it('calls db.transaction() for the outermost call', async () => {
    const { mockDb } = makeMockDb();
    await withTransaction(mockDb, async () => 'ok');
    expect(mockDb.transaction).toHaveBeenCalledOnce();
  });

  it('propagates the callback return value', async () => {
    const { mockDb } = makeMockDb();
    const result = await withTransaction(mockDb, async () => 42);
    expect(result).toBe(42);
  });

  it('re-throws errors from the callback', async () => {
    const { mockDb } = makeMockDb();
    await expect(
      withTransaction(mockDb, async () => {
        throw new Error('tx-error');
      }),
    ).rejects.toThrow('tx-error');
  });

  it('uses nested tx.transaction() (SAVEPOINT path) for calls inside an active tx', async () => {
    const { mockDb, mockTx } = makeMockDb();

    await withTransaction(mockDb, async () => {
      // This nested call should use mockTx.transaction (not mockDb.transaction)
      await withTransaction(mockDb, async () => 'inner');
    });

    expect(mockDb.transaction).toHaveBeenCalledOnce();
    expect(mockTx.transaction).toHaveBeenCalledOnce();
  });

  it('outer db.transaction() not called again for nested call', async () => {
    const { mockDb } = makeMockDb();

    await withTransaction(mockDb, async () => {
      await withTransaction(mockDb, async () => 'inner');
    });

    // db.transaction() should only be called once (for the outermost tx)
    expect(mockDb.transaction).toHaveBeenCalledOnce();
  });
});
