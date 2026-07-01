/**
 * Testing fake for ConsentLedgerBase.
 *
 * Consumers in other packages (apps/api, apps/worker, etc.) import this fake
 * from `@aggregator-dpg/consent-ledger/testing` rather than reaching into
 * `./memory`. Adds:
 *   - `seed(rows)` — inserts pre-built rows without going through the
 *     `recordRegistrationConsent` method, useful for arrange-act-assert tests.
 *   - `buildConsentRecord(overrides)` — constructs a fully-populated
 *     `ConsentRecord` with valid defaults so tests only specify the fields
 *     they care about.
 *
 * @module @aggregator-dpg/consent-ledger/testing
 */

import { InMemoryConsentLedger } from './memory.js';
import type { ConsentRecord } from './interface.js';

export { InMemoryConsentLedger };

/** Fixed ISO timestamp used by `buildConsentRecord` defaults. */
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * Testing fake for {@link ConsentLedgerBase}.
 *
 * Extends {@link InMemoryConsentLedger} so every method from the abstract
 * base class is inherited and the TypeScript compiler enforces signature
 * compatibility.
 */
export class ConsentLedgerFake extends InMemoryConsentLedger {
  /**
   * Inserts the given consent records directly into the underlying store,
   * bypassing `recordRegistrationConsent`. Useful when a test needs existing
   * consent records to exercise read or query paths.
   *
   * Re-seeding the same `id` overwrites the previous row.
   *
   * @param records - Pre-built consent records to insert.
   */
  seed(records: ConsentRecord[]): void {
    for (const record of records) {
      this.rows.set(record.id, record);
    }
  }
}

/**
 * Constructs a fully-populated {@link ConsentRecord} with valid defaults.
 *
 * Tests override only the fields they care about via the `overrides` argument.
 * All defaults pass Zod validation so the builder output can be used directly
 * in assertions.
 *
 * Defaults:
 *   - `id: 'consent-default-id'`
 *   - `subjectType: 'aggregator'`
 *   - `subjectId: '00000000-0000-0000-0000-000000000001'`
 *   - `termsVersion: 1`, `privacyVersion: 1`
 *   - `network: 'blue_dot'`, `brand: null`
 *   - `source: 'registration'`
 *   - `acceptedAt` and `createdAt`: `2026-01-01T00:00:00.000Z`
 *
 * @param overrides - Partial fields to apply on top of the defaults.
 * @returns A complete `ConsentRecord` ready to pass to `seed()` or assertions.
 */
export function buildConsentRecord(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    id: '00000000-0000-0000-0000-000000000099',
    subjectType: 'aggregator',
    subjectId: '00000000-0000-0000-0000-000000000001',
    termsVersion: 1,
    privacyVersion: 1,
    network: 'blue_dot',
    brand: null,
    source: 'registration',
    acceptedAt: FIXED_NOW,
    createdAt: FIXED_NOW,
    ...overrides,
  };
}
