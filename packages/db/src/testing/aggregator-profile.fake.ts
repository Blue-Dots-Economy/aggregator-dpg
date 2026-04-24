/**
 * In-memory fake for AggregatorProfileRepo.
 *
 * Note: AggregatorProfile uses aggregatorId as its primary key (not id).
 *
 * @module @aggregator-dpg/db/testing
 */

import { randomUUID } from 'node:crypto';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { CreateInput, UpdateInput } from '../interface.js';
import type {
  AggregatorProfileEntity,
  AggregatorProfileFilter,
} from '../repositories/aggregator-profile.repo.js';
import { InMemoryRepo } from './_in-memory-repo.js';

export class InMemoryAggregatorProfileRepo extends InMemoryRepo<
  AggregatorProfileEntity,
  AggregatorProfileFilter
> {
  protected getId(e: AggregatorProfileEntity): string {
    return e.aggregatorId;
  }

  protected getCursorDate(e: AggregatorProfileEntity): Date {
    return e.createdAt;
  }

  protected matchesFilter(e: AggregatorProfileEntity, f: AggregatorProfileFilter): boolean {
    if (f.schemaVersion !== undefined && e.schemaVersion !== f.schemaVersion) return false;
    return true;
  }

  protected makeEntity(input: CreateInput<AggregatorProfileEntity>): AggregatorProfileEntity {
    const i = input as { schemaVersion: string; valuesJson: unknown };
    const now = new Date();
    return {
      aggregatorId: randomUUID(),
      schemaVersion: i.schemaVersion,
      valuesJson: i.valuesJson,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Refreshes updatedAt on every update — matches Postgres repo behaviour. */
  protected override applyPatch(
    existing: AggregatorProfileEntity,
    patch: UpdateInput<AggregatorProfileEntity>,
  ): AggregatorProfileEntity {
    return { ...existing, ...patch, updatedAt: new Date() };
  }

  /** Lists all aggregators on a specific schema version, newest first. */
  async findBySchemaVersion(
    schemaVersion: string,
    paging?: Paging,
  ): Promise<Result<Paginated<AggregatorProfileEntity>, BaseError>> {
    return this.findMany({ schemaVersion }, paging);
  }
}

export function buildAggregatorProfile(
  overrides: Partial<AggregatorProfileEntity> = {},
): AggregatorProfileEntity {
  return {
    aggregatorId: 'agg-default',
    schemaVersion: 'schema-default',
    valuesJson: {},
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
