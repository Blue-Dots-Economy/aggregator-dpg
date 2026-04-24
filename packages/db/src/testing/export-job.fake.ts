/**
 * In-memory fake for ExportJobRepo.
 *
 * @module @aggregator-dpg/db/testing
 */

import { randomUUID } from 'node:crypto';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { CreateInput } from '../interface.js';
import type { ExportJobEntity, ExportJobFilter } from '../repositories/export-job.repo.js';
import { InMemoryRepo } from './_in-memory-repo.js';

export class InMemoryExportJobRepo extends InMemoryRepo<ExportJobEntity, ExportJobFilter> {
  protected getId(e: ExportJobEntity): string {
    return e.id;
  }

  protected getCursorDate(e: ExportJobEntity): Date {
    return e.createdAt;
  }

  protected matchesFilter(e: ExportJobEntity, f: ExportJobFilter): boolean {
    if (f.aggregatorId !== undefined && e.aggregatorId !== f.aggregatorId) return false;
    if (f.status !== undefined && e.status !== f.status) return false;
    return true;
  }

  protected makeEntity(input: CreateInput<ExportJobEntity>): ExportJobEntity {
    const i = input as {
      aggregatorId: string;
      filterJson: unknown;
      status?: 'pending' | 'processing' | 'completed' | 'failed';
      fileUrl?: string | null;
    };
    return {
      id: randomUUID(),
      aggregatorId: i.aggregatorId,
      filterJson: i.filterJson,
      status: i.status ?? 'pending',
      fileUrl: i.fileUrl ?? null,
      createdAt: new Date(),
    };
  }

  async findByStatus(
    status: 'pending' | 'processing' | 'completed' | 'failed',
    paging?: Paging,
  ): Promise<Result<Paginated<ExportJobEntity>, BaseError>> {
    return this.findMany({ status }, paging);
  }
}

export function buildExportJob(overrides: Partial<ExportJobEntity> = {}): ExportJobEntity {
  return {
    id: 'job-default',
    aggregatorId: 'agg-default',
    filterJson: {},
    status: 'pending',
    fileUrl: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
