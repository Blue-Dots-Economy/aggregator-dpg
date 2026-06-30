/**
 * Public testing surface for the aggregator store.
 *
 * Cross-package consumers must import the fake from this subpath rather than
 * reaching into the in-memory implementation directly.
 */

import { InMemoryAggregatorStore } from './memory.js';
import type { Aggregator, CreateAggregatorInput } from './interface.js';
import type { BecknContact, ConsentRecord } from '@aggregator-dpg/shared-primitives/aggregator';

export class AggregatorStoreFake extends InMemoryAggregatorStore {
  /**
   * Pre-seed the store with rows. Bypasses the invariant + uniqueness checks
   * applied by `create()` — callers are responsible for keeping seeded data
   * internally consistent.
   */
  seed(rows: Aggregator[]): void {
    for (const r of rows) this.indexInsert(r);
  }

  /** Reset between tests. */
  reset(): void {
    this.byId.clear();
    this.bySlug.clear();
    this.byPhone.clear();
    this.byEmail.clear();
  }

  /**
   * Test-only helper: overwrite the `updatedAt` timestamp on an existing row.
   *
   * Use this to back-date a row for stale-pending cleanup tests without going
   * through the public `update()` API (which stamps `updatedAt` to `now`).
   *
   * @param id - Aggregator UUID to back-date.
   * @param date - The timestamp to set on `updatedAt`.
   */
  __setUpdatedAt(id: string, date: Date): void {
    const row = this.byId.get(id);
    if (!row) throw new Error(`AggregatorStoreFake.__setUpdatedAt: id not found: ${id}`);
    this.byId.set(id, { ...row, updatedAt: date });
  }
}

const DEFAULT_CONTACT: BecknContact = {
  name: 'Default Contact',
  phone: '+919999999990',
  email: 'default@test.local',
};

const DEFAULT_CONSENT: ConsentRecord = {
  value: true,
  given_at: '2026-01-01T00:00:00.000Z',
  valid_till: '2027-01-01T00:00:00.000Z',
};

/** Test data builder with deterministic defaults. */
export function buildAggregator(overrides: Partial<Aggregator> = {}): Aggregator {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  const contact = overrides.contact ?? DEFAULT_CONTACT;
  return {
    id: '00000000-0000-0000-0000-000000000001',
    orgSlug: 'test-org-0001',
    actorType: 'aggregator',
    name: 'Test Org',
    type: null,
    url: null,
    contact,
    contactPhone: overrides.contactPhone ?? contact.phone,
    contactEmail: overrides.contactEmail ?? contact.email.toLowerCase(),
    locations: [],
    consent: DEFAULT_CONSENT,
    status: 'pending',
    createdBy: 'system',
    updatedBy: 'system',
    createdAt,
    updatedAt: createdAt,
    signalstackOrgId: null,
    parentOrgId: null,
    ...overrides,
  };
}

export function buildCreateAggregatorInput(
  overrides: Partial<CreateAggregatorInput> = {},
): CreateAggregatorInput {
  return {
    orgSlug: 'test-org-0001',
    actorType: 'aggregator',
    name: 'Test Org',
    type: null,
    contact: DEFAULT_CONTACT,
    consent: DEFAULT_CONSENT,
    createdBy: 'system',
    updatedBy: 'system',
    ...overrides,
  };
}
