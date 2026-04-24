/**
 * In-memory fake for BulkUploadBatchRepo.
 *
 * @module @aggregator-dpg/db/testing
 */

import { randomUUID } from 'node:crypto';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { CreateInput } from '../interface.js';
import type {
  BulkUploadBatchEntity,
  BulkUploadBatchFilter,
} from '../repositories/bulk-upload-batch.repo.js';
import { InMemoryRepo } from './_in-memory-repo.js';

export class InMemoryBulkUploadBatchRepo extends InMemoryRepo<
  BulkUploadBatchEntity,
  BulkUploadBatchFilter
> {
  protected getId(e: BulkUploadBatchEntity): string {
    return e.id;
  }

  protected getCursorDate(e: BulkUploadBatchEntity): Date {
    return e.createdAt;
  }

  protected matchesFilter(e: BulkUploadBatchEntity, f: BulkUploadBatchFilter): boolean {
    if (f.aggregatorId !== undefined && e.aggregatorId !== f.aggregatorId) return false;
    return true;
  }

  protected makeEntity(input: CreateInput<BulkUploadBatchEntity>): BulkUploadBatchEntity {
    const i = input as {
      aggregatorId: string;
      filename: string;
      total?: number;
      succeeded?: number;
      flagged?: number;
      createdBy: string;
    };
    return {
      id: randomUUID(),
      aggregatorId: i.aggregatorId,
      filename: i.filename,
      total: i.total ?? 0,
      succeeded: i.succeeded ?? 0,
      flagged: i.flagged ?? 0,
      createdBy: i.createdBy,
      createdAt: new Date(),
    };
  }

  async findByAggregator(
    aggregatorId: string,
    paging?: Paging,
  ): Promise<Result<Paginated<BulkUploadBatchEntity>, BaseError>> {
    return this.findMany({ aggregatorId }, paging);
  }
}

export function buildBulkUploadBatch(
  overrides: Partial<BulkUploadBatchEntity> = {},
): BulkUploadBatchEntity {
  return {
    id: 'batch-default',
    aggregatorId: 'agg-default',
    filename: 'default.csv',
    total: 0,
    succeeded: 0,
    flagged: 0,
    createdBy: 'user-default',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
