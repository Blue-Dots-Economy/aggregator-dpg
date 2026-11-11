/**
 * Bulk uploads store contract.
 *
 * Persistence port for the `bulk_uploads` table. Tracks per-CSV-upload
 * lifecycle (pending → uploaded → file_validating → row_processing →
 * completed | failed) and counters.
 */

export type BulkUploadStatus =
  | 'pending'
  | 'uploaded'
  | 'file_validating'
  | 'file_failed'
  | 'row_processing'
  | 'finalising'
  | 'completed'
  | 'failed';

export interface BulkUpload {
  id: string;
  aggregatorId: string;
  participantType: string;
  storageKey: string;
  contentFingerprint: string | null;
  status: BulkUploadStatus;
  statusReason: string | null;
  errorsCsvStorageKey: string | null;
  schemaId: string;
  schemaVersion: string;
  uploadedBy: string;
  lastProgressAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface CreateBulkUploadInput {
  aggregatorId: string;
  participantType: string;
  storageKey: string;
  schemaId: string;
  schemaVersion: string;
  uploadedBy: string;
}

export type StoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'INVALID_TRANSITION'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: StoreError };

export interface ListBulkUploadsOptions {
  limit: number;
  offset: number;
}

export interface ListBulkUploadsResult {
  rows: BulkUpload[];
  total: number;
}

export abstract class BulkUploadsStoreBase {
  /** Create a new upload row in `pending` status. */
  abstract create(input: CreateBulkUploadInput): Promise<StoreResult<BulkUpload>>;
  /** Find by id; cross-aggregator access blocked at the API layer (caller passes aggregatorId). */
  abstract findById(id: string, aggregatorId: string): Promise<StoreResult<BulkUpload | null>>;
  /**
   * Paginated list scoped to one aggregator. Most-recent first.
   */
  abstract list(
    aggregatorId: string,
    options: ListBulkUploadsOptions,
  ): Promise<StoreResult<ListBulkUploadsResult>>;
  /**
   * Transition `pending` → `uploaded` and record the content fingerprint of
   * the uploaded file.
   *
   * Idempotent: a row already `uploaded` with the same fingerprint is returned as is.
   * Any status other than `pending` or `uploaded` returns INVALID_TRANSITION.
   */
  abstract markUploaded(
    id: string,
    aggregatorId: string,
    contentFingerprint: string,
  ): Promise<StoreResult<BulkUpload>>;
  /** Delete a row that is still `pending`. */
  abstract deletePending(id: string, aggregatorId: string): Promise<StoreResult<void>>;
}
