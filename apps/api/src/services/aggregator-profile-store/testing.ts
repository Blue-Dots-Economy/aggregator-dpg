/**
 * Public testing surface for the aggregator profile store.
 */

import { InMemoryAggregatorProfileStore } from './memory.js';
import type { AggregatorProfile, CreateAggregatorProfileInput } from './interface.js';

export class AggregatorProfileStoreFake extends InMemoryAggregatorProfileStore {
  /** Pre-seed profile rows; bypasses validation in `create()`. */
  seed(rows: AggregatorProfile[]): void {
    for (const r of rows) {
      this.byAggregatorId.set(r.aggregatorId, r);
    }
  }

  reset(): void {
    this.byAggregatorId.clear();
  }
}

/** Test data builder with deterministic defaults. */
export function buildAggregatorProfile(
  overrides: Partial<AggregatorProfile> = {},
): AggregatorProfile {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    aggregatorId: '00000000-0000-0000-0000-000000000001',
    contactName: null,
    personas: [],
    services: [],
    verifiedCertificate: [],
    profileCompletedAt: null,
    createdBy: 'self',
    updatedBy: 'self',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

export function buildCreateAggregatorProfileInput(
  overrides: Partial<CreateAggregatorProfileInput> = {},
): CreateAggregatorProfileInput {
  return {
    aggregatorId: '00000000-0000-0000-0000-000000000001',
    createdBy: 'self',
    updatedBy: 'self',
    ...overrides,
  };
}
