/**
 * Test helpers for the bulk uploads store (`@aggregator-dpg/api`): the
 * in-memory fake and a builder.
 */

import type { BulkUpload } from './interface.js';
import { InMemoryBulkUploadsStore } from './memory.js';

/** In-memory fake with `seed()` and a read of the stored row. */
export class BulkUploadsStoreFake extends InMemoryBulkUploadsStore {
  /** Pre-loads rows; a row with an existing id replaces it. */
  seed(rows: BulkUpload[]): void {
    for (const row of rows) this.rows.set(row.id, row);
  }

  /** The stored row, whatever its coordinator. */
  get(id: string): BulkUpload | undefined {
    return this.rows.get(id);
  }
}

/** Builds one `pending` upload with fixed defaults. */
export function buildBulkUpload(overrides: Partial<BulkUpload> = {}): BulkUpload {
  const at = new Date('2026-01-01T00:00:00Z');
  return {
    id: '00000000-0000-4000-8000-000000000001',
    aggregatorId: '00000000-0000-4000-8000-0000000000aa',
    participantType: 'seeker',
    storageKey: 'pending',
    contentFingerprint: null,
    status: 'pending',
    statusReason: null,
    errorsCsvStorageKey: null,
    schemaId: 'participant-seeker',
    schemaVersion: 'v1',
    uploadedBy: 'kc-subject-1',
    lastProgressAt: null,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    ...overrides,
  };
}
