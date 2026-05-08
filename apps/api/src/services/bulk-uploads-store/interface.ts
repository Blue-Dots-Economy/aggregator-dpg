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
  participantType: 'seeker' | 'provider';
  s3Key: string;
  s3Etag: string | null;
  status: BulkUploadStatus;
  statusReason: string | null;
  totalRows: number | null;
  passed: number;
  failed: number;
  skipped: number;
  errorsCsvS3Key: string | null;
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
  participantType: 'seeker' | 'provider';
  s3Key: string;
  schemaId: string;
  schemaVersion: string;
  uploadedBy: string;
}

export type StoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'DUPLICATE_ETAG'; message: string }
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
  /** Find an existing pending/in-flight upload for a re-uploaded ETag. */
  abstract findByAggregatorAndEtag(
    aggregatorId: string,
    s3Etag: string,
  ): Promise<StoreResult<BulkUpload | null>>;
  /**
   * Paginated list scoped to one aggregator. Most-recent first.
   */
  abstract list(
    aggregatorId: string,
    options: ListBulkUploadsOptions,
  ): Promise<StoreResult<ListBulkUploadsResult>>;
  /**
   * Transition `pending` → `uploaded` and record the S3 ETag captured by
   * the API after the browser confirms the PUT completed.
   *
   * Idempotent: calling on a row already in `uploaded` (or later) is a
   * no-op and returns the current row. Calling on a terminal status
   * (completed | failed) returns INVALID_TRANSITION.
   */
  abstract markUploaded(
    id: string,
    aggregatorId: string,
    s3Etag: string,
  ): Promise<StoreResult<BulkUpload>>;
  /**
   * Delete a row that is still `pending`. Used to clean up orphan rows
   * created when a re-upload of identical CSV bytes hits the
   * (aggregator_id, s3_etag) UNIQUE conflict — we keep the original row
   * (which already holds the etag) and drop the pending duplicate so the
   * user does not see a stale entry in their list.
   */
  abstract deletePending(id: string, aggregatorId: string): Promise<StoreResult<void>>;
}
