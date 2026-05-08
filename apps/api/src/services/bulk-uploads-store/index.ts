/**
 * Public surface and factory for the bulk uploads store.
 *
 * Returns a process-wide singleton. Tests override via `_setBulkUploadsStore`.
 */

import type { BulkUploadsStoreBase } from './interface.js';
import { PostgresBulkUploadsStore } from './postgres.js';

let instance: BulkUploadsStoreBase | null = null;

export function getBulkUploadsStore(): BulkUploadsStoreBase {
  if (instance) return instance;
  instance = new PostgresBulkUploadsStore();
  return instance;
}

/** Test helper — replace the singleton. */
export function _setBulkUploadsStore(s: BulkUploadsStoreBase | null): void {
  instance = s;
}

export { BulkUploadsStoreBase } from './interface.js';
export type {
  BulkUpload,
  BulkUploadStatus,
  CreateBulkUploadInput,
  StoreError,
  StoreResult,
} from './interface.js';
export { PostgresBulkUploadsStore } from './postgres.js';
