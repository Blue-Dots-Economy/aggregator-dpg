/**
 * withTransaction — runs a callback inside a Postgres transaction.
 *
 * Uses AsyncLocalStorage to detect nesting. Outer calls use BEGIN/COMMIT/ROLLBACK
 * via Drizzle; inner calls automatically use SAVEPOINTs via Drizzle's nested
 * transaction support. The tx-scoped Drizzle client is propagated through the
 * async call tree without manual threading.
 *
 * @module @aggregator-dpg/db/postgres (internal)
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { DrizzleDB } from './drizzle.js';
import type { DrizzleUoW } from './uow.js';
import { buildUoW } from './uow.js';

const txStorage = new AsyncLocalStorage<DrizzleDB>();

/**
 * Runs fn inside a Postgres transaction.
 *
 * If already inside a transaction (detected via AsyncLocalStorage), opens a
 * SAVEPOINT instead. Commits / releases on success; rolls back on throw.
 *
 * @param db - Root Drizzle client (pool-level).
 * @param fn - Work to perform inside the transaction scope.
 * @returns The value returned by fn.
 * @throws Re-throws whatever fn throws after rolling back or releasing to savepoint.
 */
export async function withTransaction<T>(
  db: DrizzleDB,
  fn: (uow: DrizzleUoW) => Promise<T>,
): Promise<T> {
  const activeTx = txStorage.getStore();

  if (activeTx) {
    // Already inside a transaction — use SAVEPOINT via Drizzle's nested tx
    return activeTx.transaction(async (nestedTx) => {
      const nestedDb = nestedTx as unknown as DrizzleDB;
      return txStorage.run(nestedDb, () => fn(buildUoW(nestedDb)));
    });
  }

  // Outermost transaction — BEGIN / COMMIT / ROLLBACK
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as DrizzleDB;
    return txStorage.run(txDb, () => fn(buildUoW(txDb)));
  });
}
