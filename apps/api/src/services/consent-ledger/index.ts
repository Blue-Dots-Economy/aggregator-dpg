/**
 * Public surface and factory for the consent ledger.
 *
 * Returns a process-wide singleton wired to the shared Drizzle DB client.
 * Tests override via `_setConsentLedger`.
 *
 * @module apps/api/services/consent-ledger
 */

import type { ConsentLedgerBase } from '@aggregator-dpg/consent-ledger/interface';
import { PostgresConsentLedger } from '@aggregator-dpg/consent-ledger/postgres';
import { getDb } from '../../db/client.js';

let instance: ConsentLedgerBase | null = null;

/**
 * Returns the shared consent ledger singleton.
 *
 * Lazy-initialised on first call; subsequent calls return the cached instance.
 * The ledger is wired to the same Drizzle DB handle used by every other store
 * in this process.
 *
 * @returns The process-wide {@link ConsentLedgerBase} instance.
 */
export function getConsentLedger(): ConsentLedgerBase {
  if (instance) return instance;
  instance = new PostgresConsentLedger(getDb());
  return instance;
}

/**
 * Test helper — replace the singleton with a custom instance (e.g. a fake).
 * Pass `null` to reset to uninitialized so the next call re-creates the real impl.
 *
 * @param ledger - The replacement ledger, or `null` to reset.
 */
export function _setConsentLedger(ledger: ConsentLedgerBase | null): void {
  instance = ledger;
}

export type { ConsentLedgerBase } from '@aggregator-dpg/consent-ledger/interface';
