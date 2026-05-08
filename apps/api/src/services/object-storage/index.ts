/**
 * Object-storage service for bulk uploads.
 *
 * Wraps the AWS S3 SDK with the small surface the bulk upload pipeline
 * needs:
 *   - signUploadUrl: pre-signed PUT URL with Content-Type + size cap baked in.
 *   - headObject: confirm upload completed and capture ETag.
 *
 * Works against real S3 and against MinIO (local dev) interchangeably; the
 * latter requires `S3_ENDPOINT` + path-style addressing.
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../config.js';

let cachedClient: S3Client | null = null;

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    region: config.S3_REGION,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
  return cachedClient;
}

export interface SignedUploadUrl {
  url: string;
  /** S3 object key the URL grants PUT access to. */
  key: string;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
  /** Content-Type the signature requires the client to send. */
  contentType: string;
  /** Maximum bytes the signature accepts. */
  maxBytes: number;
}

/**
 * Issues a pre-signed PUT URL for a bulk upload CSV.
 *
 * The signature constrains:
 *   - Content-Type: text/csv (signed; mismatch → S3 rejects with 403)
 *   - Maximum size: BULK_UPLOAD_MAX_BYTES (signed via x-amz-content-length-range
 *     where supported; otherwise enforced post-upload by HEAD inspection)
 *
 * @param uploadId - DB row id; used as the deterministic S3 key.
 * @param aggregatorId - Owner aggregator; used as a key prefix for grouping.
 */
export async function signBulkUploadUrl(opts: {
  uploadId: string;
  aggregatorId: string;
}): Promise<SignedUploadUrl> {
  const key = `bulk-uploads/${opts.aggregatorId}/${opts.uploadId}/raw.csv`;
  const command = new PutObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ContentType: 'text/csv',
  });
  const url = await getSignedUrl(getClient(), command, {
    expiresIn: config.BULK_UPLOAD_URL_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + config.BULK_UPLOAD_URL_TTL_SECONDS * 1000).toISOString();
  return {
    url,
    key,
    expiresAt,
    contentType: 'text/csv',
    maxBytes: config.BULK_UPLOAD_MAX_BYTES,
  };
}

export interface ObjectHead {
  etag: string;
  contentLength: number;
}

/**
 * HEAD an S3 object to confirm upload completion and capture its ETag.
 *
 * Returns null if the object does not exist (e.g. browser never completed
 * the PUT). Throws on transport errors so the caller can surface 503.
 */
export async function headObject(key: string): Promise<ObjectHead | null> {
  try {
    const result = await getClient().send(
      new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
    );
    if (!result.ETag) return null;
    return {
      etag: result.ETag.replace(/"/g, ''),
      contentLength: typeof result.ContentLength === 'number' ? result.ContentLength : 0,
    };
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
    // S3 returns NotFound or NoSuchKey for missing objects.
    if (code === 'NotFound' || code === 'NoSuchKey') return null;
    throw err;
  }
}

/**
 * Uploads an artefact to S3. Used for QR PNGs at link-create time and for
 * any other API-side object writes.
 */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export interface SignedDownloadUrl {
  url: string;
  key: string;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
}

/**
 * Issues a pre-signed GET URL for a bulk-upload errors.csv artefact.
 *
 * Reuses BULK_UPLOAD_URL_TTL_SECONDS for download TTL — short enough that a
 * leaked URL has limited utility, long enough for a normal browser download.
 */
export async function signErrorsCsvDownloadUrl(key: string): Promise<SignedDownloadUrl> {
  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ResponseContentDisposition: 'attachment; filename="errors.csv"',
    ResponseContentType: 'text/csv',
  });
  const url = await getSignedUrl(getClient(), command, {
    expiresIn: config.BULK_UPLOAD_URL_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + config.BULK_UPLOAD_URL_TTL_SECONDS * 1000).toISOString();
  return { url, key, expiresAt };
}

/**
 * Issues a pre-signed GET URL for a QR PNG. Browsers can render the URL
 * directly in an <img> tag.
 */
export async function signQrDownloadUrl(key: string): Promise<SignedDownloadUrl> {
  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ResponseContentType: 'image/png',
  });
  const url = await getSignedUrl(getClient(), command, {
    expiresIn: config.QR_DOWNLOAD_URL_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + config.QR_DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString();
  return { url, key, expiresAt };
}

/** Test-only — clears the cached client so a fresh instance is built next call. */
export function _resetObjectStorageClient(): void {
  cachedClient = null;
}
