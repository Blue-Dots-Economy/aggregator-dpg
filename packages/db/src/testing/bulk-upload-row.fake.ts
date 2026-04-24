/**
 * In-memory fake for BulkUploadRowRepo.
 *
 * @module @aggregator-dpg/db/testing
 */

import { randomUUID } from 'node:crypto';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { CreateInput } from '../interface.js';
import type {
  BulkUploadRowEntity,
  BulkUploadRowFilter,
} from '../repositories/bulk-upload-row.repo.js';
import { InMemoryRepo } from './_in-memory-repo.js';

export class InMemoryBulkUploadRowRepo extends InMemoryRepo<
  BulkUploadRowEntity,
  BulkUploadRowFilter
> {
  protected override defaultLimit(): number {
    return 100;
  }

  protected override maxLimit(): number {
    return 500;
  }

  protected getId(e: BulkUploadRowEntity): string {
    return e.id;
  }

  protected getCursorDate(e: BulkUploadRowEntity): Date {
    return e.createdAt;
  }

  protected matchesFilter(e: BulkUploadRowEntity, f: BulkUploadRowFilter): boolean {
    if (f.batchId !== undefined && e.batchId !== f.batchId) return false;
    if (f.outcome !== undefined && e.outcome !== f.outcome) return false;
    return true;
  }

  protected makeEntity(input: CreateInput<BulkUploadRowEntity>): BulkUploadRowEntity {
    const i = input as {
      batchId: string;
      rowNumber: number;
      rawRowJson: unknown;
      outcome: 'success' | 'flagged' | 'error';
      errorCode?: string | null;
      errorMessage?: string | null;
    };
    return {
      id: randomUUID(),
      batchId: i.batchId,
      rowNumber: i.rowNumber,
      rawRowJson: i.rawRowJson,
      outcome: i.outcome,
      errorCode: i.errorCode ?? null,
      errorMessage: i.errorMessage ?? null,
      createdAt: new Date(),
    };
  }

  async findByBatch(
    batchId: string,
    paging?: Paging,
  ): Promise<Result<Paginated<BulkUploadRowEntity>, BaseError>> {
    return this.findMany({ batchId }, paging);
  }
}

export function buildBulkUploadRow(
  overrides: Partial<BulkUploadRowEntity> = {},
): BulkUploadRowEntity {
  return {
    id: 'row-default',
    batchId: 'batch-default',
    rowNumber: 1,
    rawRowJson: {},
    outcome: 'success',
    errorCode: null,
    errorMessage: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
