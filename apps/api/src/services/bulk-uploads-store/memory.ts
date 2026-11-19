/**
 * In-memory bulk uploads store for tests (`@aggregator-dpg/api`). Same
 * outcomes as the Postgres adapter: rows scoped by coordinator, the
 * `pending` → `uploaded` guard, and `list` leaving out uploads that never started.
 */

import { randomUUID } from 'node:crypto';
import {
  BulkUploadsStoreBase,
  type BulkUpload,
  type CreateBulkUploadInput,
  type ListBulkUploadsOptions,
  type ListBulkUploadsResult,
  type StoreResult,
} from './interface.js';

/** In-memory {@link BulkUploadsStoreBase}. */
export class InMemoryBulkUploadsStore extends BulkUploadsStoreBase {
  protected readonly rows = new Map<string, BulkUpload>();

  async create(input: CreateBulkUploadInput): Promise<StoreResult<BulkUpload>> {
    const now = new Date();
    const row: BulkUpload = {
      ...input,
      id: randomUUID(),
      contentFingerprint: null,
      status: 'pending',
      statusReason: null,
      errorsCsvStorageKey: null,
      lastProgressAt: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.rows.set(row.id, row);
    return { ok: true, value: row };
  }

  async findById(id: string, aggregatorId: string): Promise<StoreResult<BulkUpload | null>> {
    const row = this.rows.get(id);
    return { ok: true, value: row?.aggregatorId === aggregatorId ? row : null };
  }

  async list(
    aggregatorId: string,
    options: ListBulkUploadsOptions,
  ): Promise<StoreResult<ListBulkUploadsResult>> {
    const all = [...this.rows.values()]
      .filter(
        (r) =>
          r.aggregatorId === aggregatorId &&
          r.status !== 'pending' &&
          r.statusReason !== 'upload_abandoned',
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      ok: true,
      value: { rows: all.slice(options.offset, options.offset + options.limit), total: all.length },
    };
  }

  async markUploaded(
    id: string,
    aggregatorId: string,
    contentFingerprint: string,
  ): Promise<StoreResult<BulkUpload>> {
    const row = this.rows.get(id);
    if (row?.aggregatorId !== aggregatorId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `upload not found: ${id}` } };
    }
    if (row.status !== 'pending' && row.status !== 'uploaded') {
      return {
        ok: false,
        error: {
          code: 'INVALID_TRANSITION',
          message: `cannot mark uploaded from status=${row.status}`,
        },
      };
    }
    const updated: BulkUpload = {
      ...row,
      status: 'uploaded',
      contentFingerprint,
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return { ok: true, value: updated };
  }

  async setStorageKey(id: string, storageKey: string): Promise<StoreResult<void>> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, storageKey, updatedAt: new Date() });
    return { ok: true, value: undefined };
  }

  async deletePending(id: string, aggregatorId: string): Promise<StoreResult<void>> {
    const row = this.rows.get(id);
    if (row?.aggregatorId === aggregatorId && row.status === 'pending') this.rows.delete(id);
    return { ok: true, value: undefined };
  }
}
