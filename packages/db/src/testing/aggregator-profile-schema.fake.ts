/**
 * In-memory fake for AggregatorProfileSchemaRepo.
 *
 * Import via @aggregator-dpg/db/testing from external packages.
 *
 * @module @aggregator-dpg/db/testing
 */

import { randomUUID } from 'node:crypto';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { CreateInput } from '../interface.js';
import type {
  AggregatorProfileSchemaEntity,
  AggregatorProfileSchemaFilter,
} from '../repositories/aggregator-profile-schema.repo.js';
import { InMemoryRepo } from './_in-memory-repo.js';

export class InMemoryAggregatorProfileSchemaRepo extends InMemoryRepo<
  AggregatorProfileSchemaEntity,
  AggregatorProfileSchemaFilter
> {
  protected getId(e: AggregatorProfileSchemaEntity): string {
    return e.id;
  }

  protected getCursorDate(e: AggregatorProfileSchemaEntity): Date {
    return e.createdAt;
  }

  protected matchesFilter(
    e: AggregatorProfileSchemaEntity,
    f: AggregatorProfileSchemaFilter,
  ): boolean {
    if (f.active !== undefined && e.active !== f.active) return false;
    if (f.version !== undefined && e.version !== f.version) return false;
    return true;
  }

  protected makeEntity(
    input: CreateInput<AggregatorProfileSchemaEntity>,
  ): AggregatorProfileSchemaEntity {
    const i = input as {
      version: string;
      schemaJson: unknown;
      active?: boolean;
    };
    return {
      id: randomUUID(),
      version: i.version,
      schemaJson: i.schemaJson,
      active: i.active ?? false,
      createdAt: new Date(),
    };
  }

  /** Returns the newest row where active = true. */
  async findActive(): Promise<Result<AggregatorProfileSchemaEntity | null, BaseError>> {
    let newest: AggregatorProfileSchemaEntity | null = null;
    for (const e of this.store.values()) {
      if (!e.active) continue;
      if (!newest || e.createdAt > newest.createdAt) newest = e;
    }
    return ok(newest);
  }
}

/**
 * Builder for AggregatorProfileSchemaEntity — deterministic defaults.
 */
export function buildAggregatorProfileSchema(
  overrides: Partial<AggregatorProfileSchemaEntity> = {},
): AggregatorProfileSchemaEntity {
  return {
    id: 'schema-default',
    version: '1',
    schemaJson: {},
    active: false,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
