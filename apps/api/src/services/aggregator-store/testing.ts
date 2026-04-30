/**
 * Public testing surface for the aggregator store.
 *
 * Cross-package consumers must import the fake from this subpath rather than
 * reaching into the in-memory implementation directly.
 */

import { InMemoryAggregatorStore } from './memory.js';
import type { Aggregator, CreateAggregatorInput } from './interface.js';

export class AggregatorStoreFake extends InMemoryAggregatorStore {
  /** Pre-seed the store with rows; bypasses validation in `create()`. */
  seed(rows: Aggregator[]): void {
    for (const r of rows) {
      this.byId.set(r.id, r);
      this.bySlug.set(r.orgSlug, r.id);
    }
  }

  /** Reset between tests. */
  reset(): void {
    this.byId.clear();
    this.bySlug.clear();
  }
}

/** Test data builder with deterministic defaults. */
export function buildAggregator(overrides: Partial<Aggregator> = {}): Aggregator {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    id: '00000000-0000-0000-0000-000000000001',
    orgSlug: 'test-org-0001',
    type: 'seeker',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

export function buildCreateAggregatorInput(
  overrides: Partial<CreateAggregatorInput> = {},
): CreateAggregatorInput {
  return {
    orgSlug: 'test-org-0001',
    type: 'seeker',
    ...overrides,
  };
}
