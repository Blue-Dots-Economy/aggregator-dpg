/**
 * The create and start steps of a bulk upload, shared by the bulk-upload
 * routes and the operator command (`tools/bulk-upload.ts`). Belongs to
 * `@aggregator-dpg/api`.
 *
 * These functions throw `HttpError` instead of returning a `Result`, an
 * exception to the service convention: they hold the routes' own code
 * unchanged, so the routes keep their responses. Both callers map
 * `HttpError`: the routes through the app's error handler, the command to its
 * `REFUSED:` and `FAILED:` lines.
 */

import type { FastifyBaseLogger } from 'fastify';
import { buildKey, getObjectStorage, type ObjectRef } from '@aggregator-dpg/object-storage';
import type { ObjectStat } from '@aggregator-dpg/object-storage/interface';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { errorMessage, ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import { config } from '../../config.js';
import { httpError } from '../../errors/http-error.js';
import { enqueueBulkFileProcess } from '../bulk-queue/index.js';
import { getBulkUploadsStore } from '../bulk-uploads-store/index.js';
import type { BulkUpload } from '../bulk-uploads-store/interface.js';
import { getConsentLedger } from '../consent-ledger/index.js';
import { getNetworkConfig } from '../network-config.js';
import { servedDomains } from '../user-store/serves.js';

/** Only v1 of each participant schema exists. */
const SCHEMA_VERSION = 'v1';

/** Input of {@link reserveBulkUpload}. */
export interface ReserveBulkUploadInput {
  /** The coordinator (`users.id`) the upload belongs to. */
  aggregatorId: string;
  /** Stored as `bulk_uploads.uploaded_by`: the coordinator's Keycloak subject. */
  uploadedBy: string;
  /** The profile types the coordinator serves. */
  serves: readonly string[];
  participantType: string;
  log: FastifyBaseLogger;
}

/** A reserved upload and where its CSV goes. */
export interface ReservedBulkUpload {
  upload: BulkUpload;
  ref: ObjectRef;
}

/**
 * Checks the profile type and reserves a `pending` upload row; returns where its CSV goes.
 *
 * @throws SCHEMA_VALIDATION if the type is not a network domain.
 * @throws DOMAIN_NOT_SERVED if the coordinator does not serve it.
 * @throws DB_UNAVAILABLE if the row cannot be written.
 */
export async function reserveBulkUpload(
  input: ReserveBulkUploadInput,
): Promise<ReservedBulkUpload> {
  const { aggregatorId, participantType, log } = input;
  const start = Date.now();
  const networkCfg = await getNetworkConfig();
  if (!networkCfg.domainIds.includes(participantType)) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: `participant_type must be one of: ${networkCfg.domainIds.join(', ')}.`,
      fields: { participant_type: 'invalid' },
    });
  }
  const served = servedDomains([...input.serves], networkCfg.domainIds);
  if (!served.includes(participantType)) {
    throw httpError('DOMAIN_NOT_SERVED', {
      fields: { requested_domain: participantType, served_domains: served },
    });
  }

  const created = await getBulkUploadsStore().create({
    aggregatorId,
    participantType,
    // Placeholder; the real key needs the row id and is set by saveStorageKey.
    storageKey: 'pending',
    schemaId: `participant-${participantType}`,
    schemaVersion: SCHEMA_VERSION,
    uploadedBy: input.uploadedBy,
  });
  if (!created.ok) {
    log.error({ status: 'failure', error: created.error.code, latency_ms: Date.now() - start });
    throw httpError('DB_UNAVAILABLE', { cause: new Error(created.error.message) });
  }

  const storageKey = buildKey('bulk-uploads', aggregatorId, created.value.id, 'raw.csv');
  return { upload: created.value, ref: { area: 'bulk-uploads', key: storageKey } };
}

/**
 * Stores the upload's real storage key once the file's destination is ready.
 *
 * @throws {Error} When the store cannot write it.
 */
export async function saveStorageKey(uploadId: string, storageKey: string): Promise<void> {
  const saved = await getBulkUploadsStore().setStorageKey(uploadId, storageKey);
  if (!saved.ok) throw new Error(saved.error.message);
}

/** Input of {@link startBulkUpload}. */
export interface StartBulkUploadInput {
  uploadId: string;
  aggregatorId: string;
  /** The uploader's attestation of authority to upload; must be `true`. */
  attestation: boolean | undefined;
  log: FastifyBaseLogger;
}

/** What {@link startBulkUpload} did. */
export type StartBulkUploadOutcome =
  | { kind: 'started'; upload: BulkUpload; head: ObjectStat }
  /** The upload was already past `uploaded`; nothing changed. */
  | { kind: 'already_started'; upload: BulkUpload };

/**
 * Checks the stored CSV, records the attestation, marks the upload `uploaded`
 * and enqueues file processing.
 *
 * @throws FORBIDDEN if the upload is not the coordinator's.
 * @throws CONSENT_REQUIRED if `attestation` is not `true`.
 * @throws SCHEMA_VALIDATION if the file is missing, empty or too large.
 * @throws CONSENT_WRITE_FAILED if the attestation cannot be recorded.
 * @throws DB_UNAVAILABLE, INTERNAL on store or queue failures.
 */
export async function startBulkUpload(
  input: StartBulkUploadInput,
): Promise<StartBulkUploadOutcome> {
  const { uploadId, aggregatorId, log } = input;
  const start = Date.now();
  const store = getBulkUploadsStore();
  const found = await store.findById(uploadId, aggregatorId);
  if (!found.ok) {
    throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
  }
  if (!found.value) {
    // 403 to prevent cross-aggregator enumeration.
    throw httpError('FORBIDDEN', { detail: 'Upload not accessible.' });
  }

  const upload = found.value;
  // Already past 'uploaded': return the current state.
  if (upload.status !== 'pending' && upload.status !== 'uploaded') {
    log.warn({
      status: 'skipped',
      reason: 'invalid_transition',
      current_status: upload.status,
      latency_ms: Date.now() - start,
    });
    return { kind: 'already_started', upload };
  }

  // Checked before any storage call or state change.
  if (input.attestation !== true) {
    throw httpError('CONSENT_REQUIRED', {
      detail: 'You must confirm authority to upload before starting.',
      fields: { attestation: input.attestation ?? null },
    });
  }

  const uploadRef: ObjectRef = { area: 'bulk-uploads', key: upload.storageKey };
  const statResult = await getObjectStorage().stat(uploadRef);
  if (!statResult.success && !(statResult.error instanceof ValidationError)) {
    throw statResult.error;
  }
  const head = statResult.success ? statResult.value : null;
  if (!head) {
    log.warn({
      status: 'failure',
      reason: 'storage_object_missing',
      storage_key: upload.storageKey,
      latency_ms: Date.now() - start,
    });
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'CSV upload not found in object storage. Complete the upload and retry.',
      fields: { reason: 'upload_missing' },
    });
  }
  if (head.size === 0) {
    await deleteRejectedUpload(uploadRef, log);
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'Uploaded CSV is empty.',
      fields: { reason: 'empty' },
    });
  }
  if (head.size > config.BULK_UPLOAD_MAX_BYTES) {
    await deleteRejectedUpload(uploadRef, log);
    log.warn({
      status: 'failure',
      reason: 'object_too_large',
      storage_key: upload.storageKey,
      content_length: head.size,
      max_bytes: config.BULK_UPLOAD_MAX_BYTES,
    });
    throw httpError('SCHEMA_VALIDATION', {
      detail: `Uploaded CSV is too large (${head.size} bytes; max ${config.BULK_UPLOAD_MAX_BYTES}).`,
      fields: { reason: 'too_large', max_bytes: config.BULK_UPLOAD_MAX_BYTES },
    });
  }

  // Record the attestation before the state change. Fails closed: no upload
  // is processed without one.
  const attestationRecorded = await recordBulkUploadAttestation({ aggregatorId, uploadId, log });
  if (!attestationRecorded) {
    throw httpError('CONSENT_WRITE_FAILED', {
      fields: { sub_operation: 'recordBulkUploadAttestation' },
    });
  }

  // Re-uploading the same file is allowed, so a failure here is never a duplicate.
  const marked = await store.markUploaded(uploadId, aggregatorId, head.fingerprint);
  if (!marked.ok) {
    throw httpError('DB_UNAVAILABLE', { cause: new Error(marked.error.message) });
  }

  try {
    await enqueueBulkFileProcess({
      uploadId: marked.value.id,
      aggregatorId,
      s3Key: marked.value.storageKey,
      participantType: marked.value.participantType,
      schemaId: marked.value.schemaId,
      schemaVersion: marked.value.schemaVersion,
    });
  } catch (err) {
    // The row stays 'uploaded'; the stuck-job watchdog picks it up.
    log.error({
      status: 'failure',
      sub_operation: 'enqueue.bulk-file-process',
      error: errorMessage(err),
    });
    throw httpError('INTERNAL', { cause: err });
  }

  return { kind: 'started', upload: marked.value, head };
}

/** Deletes a rejected stored file; a failed delete is logged and never changes the response. */
export async function deleteRejectedUpload(
  ref: ObjectRef,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<void> {
  const deleted = await getObjectStorage().delete(ref);
  if (deleted.success) return;
  log.warn({
    status: 'failure',
    reason: 'rejected_upload_delete_failed',
    storage_key: ref.key,
    error: deleted.error.message,
  });
}

/**
 * Records the bulk-upload attestation in the consent ledger.
 *
 * The `source` is `bulk_upload:<uploadId>:v<n>`; the terms and privacy
 * versions go in their own columns. Returns `false` on any failure so the
 * caller aborts the upload.
 */
async function recordBulkUploadAttestation({
  aggregatorId,
  uploadId,
  log,
}: {
  aggregatorId: string;
  uploadId: string;
  log: FastifyBaseLogger;
}): Promise<boolean> {
  const { network, brand } = resolveActiveNetwork();
  let termsVersion: number;
  let privacyVersion: number;
  let attestationVersion: number;
  try {
    const consentCfg = await loadConsentConfig(network, brand);
    const docs = consentCfg.audiences.aggregator.documents;
    const attestation = docs.bulk_upload_attestation;
    if (!attestation) {
      log.error(
        { operation: 'consentLedger.recordBulkUploadAttestation', status: 'failure' },
        'bulk_upload_attestation not configured for the aggregator audience',
      );
      return false;
    }
    termsVersion = docs.terms.current_version;
    privacyVersion = docs.privacy.current_version;
    attestationVersion = attestation.current_version;
  } catch (e) {
    log.error(
      {
        operation: 'consentLedger.recordBulkUploadAttestation',
        status: 'failure',
        error: errorMessage(e),
      },
      'consent config load failed — bulk upload rejected',
    );
    return false;
  }

  const result = await getConsentLedger().recordRegistrationConsent({
    subjectType: 'user',
    subjectId: aggregatorId,
    network,
    brand: brand ?? null,
    termsVersion,
    privacyVersion,
    source: `bulk_upload:${uploadId}:v${attestationVersion}`,
  });
  if (!result.success) {
    log.error(
      {
        operation: 'consentLedger.recordBulkUploadAttestation',
        status: 'failure',
        error: result.error.message,
      },
      'attestation ledger write failed — bulk upload rejected',
    );
    return false;
  }
  return true;
}
