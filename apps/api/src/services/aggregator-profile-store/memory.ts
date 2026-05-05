/**
 * In-memory aggregator profile store. Same external behaviour as the
 * Postgres adapter for unit-test coverage.
 */

import {
  AggregatorProfileStoreBase,
  type AggregatorProfile,
  type CreateAggregatorProfileInput,
  type ProfileStoreResult,
  type UpdateAggregatorProfileInput,
} from './interface.js';

export class InMemoryAggregatorProfileStore extends AggregatorProfileStoreBase {
  protected readonly byAggregatorId = new Map<string, AggregatorProfile>();

  async create(
    input: CreateAggregatorProfileInput,
  ): Promise<ProfileStoreResult<AggregatorProfile>> {
    if (this.byAggregatorId.has(input.aggregatorId)) {
      return {
        ok: false,
        error: { code: 'DUPLICATE', message: `profile exists for ${input.aggregatorId}` },
      };
    }
    const now = new Date();
    const row: AggregatorProfile = {
      aggregatorId: input.aggregatorId,
      schemaVersion: input.schemaVersion ?? 1,
      data: input.data ?? {},
      consent: input.consent ?? {},
      createdBy: input.createdBy,
      updatedBy: input.updatedBy,
      createdAt: now,
      updatedAt: now,
    };
    this.byAggregatorId.set(row.aggregatorId, row);
    return { ok: true, value: row };
  }

  async findByAggregatorId(
    aggregatorId: string,
  ): Promise<ProfileStoreResult<AggregatorProfile | null>> {
    return { ok: true, value: this.byAggregatorId.get(aggregatorId) ?? null };
  }

  async update(
    aggregatorId: string,
    input: UpdateAggregatorProfileInput,
  ): Promise<ProfileStoreResult<AggregatorProfile>> {
    const existing = this.byAggregatorId.get(aggregatorId);
    if (!existing) {
      return { ok: false, error: { code: 'NOT_FOUND', message: aggregatorId } };
    }
    const next: AggregatorProfile = {
      ...existing,
      schemaVersion: input.schemaVersion ?? existing.schemaVersion,
      data: input.data ?? existing.data,
      consent: input.consent ?? existing.consent,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    };
    this.byAggregatorId.set(aggregatorId, next);
    return { ok: true, value: next };
  }
}
