/**
 * Public testing surface for the aggregator-org store.
 *
 * Cross-module consumers import the fake from here, never the in-memory impl
 * directly (testing rule).
 */

import { InMemoryAggregatorOrgStore } from './memory.js';
import type { AggregatorOrg } from './interface.js';

export class AggregatorOrgStoreFake extends InMemoryAggregatorOrgStore {
  /**
   * Pre-seed rows, bypassing create()'s slug check. Callers are responsible
   * for keeping seeded data internally consistent.
   *
   * @param rows - Rows to insert before the test runs.
   */
  seed(rows: AggregatorOrg[]): void {
    for (const r of rows) this.byId.set(r.id, r);
  }

  /** Reset between tests. */
  reset(): void {
    this.byId.clear();
  }
}

/**
 * Deterministic test data builder for an {@link AggregatorOrg}.
 *
 * @param overrides - Field overrides; defaults are valid and snapshot-stable.
 * @returns A fully-populated org row.
 */
export function buildAggregatorOrg(overrides: Partial<AggregatorOrg> = {}): AggregatorOrg {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    id: '00000000-0000-0000-0000-0000000000a1',
    slug: 'test-org',
    displayName: 'Test Org',
    state: null,
    ownerEmail: 'owner@test.local',
    ownerPhone: null,
    ownerKcSub: null,
    kcGroupId: null,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}
