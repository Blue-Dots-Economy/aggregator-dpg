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
      contactName: input.contactName ?? null,
      personas: input.personas ?? [],
      services: input.services ?? [],
      verifiedCertificate: input.verifiedCertificate ?? [],
      profileCompletedAt: null,
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
      contactName: input.contactName !== undefined ? input.contactName : existing.contactName,
      personas: input.personas ?? existing.personas,
      services: input.services ?? existing.services,
      verifiedCertificate: input.verifiedCertificate ?? existing.verifiedCertificate,
      profileCompletedAt:
        input.profileCompletedAt !== undefined
          ? input.profileCompletedAt
          : existing.profileCompletedAt,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    };
    this.byAggregatorId.set(aggregatorId, next);
    return { ok: true, value: next };
  }

  async markCompleted(
    aggregatorId: string,
    updatedBy: string,
  ): Promise<ProfileStoreResult<AggregatorProfile>> {
    return this.update(aggregatorId, { profileCompletedAt: new Date(), updatedBy });
  }

  async deleteByAggregatorId(aggregatorId: string): Promise<ProfileStoreResult<void>> {
    if (!this.byAggregatorId.has(aggregatorId)) {
      return { ok: false, error: { code: 'NOT_FOUND', message: aggregatorId } };
    }
    this.byAggregatorId.delete(aggregatorId);
    return { ok: true, value: undefined };
  }
}
