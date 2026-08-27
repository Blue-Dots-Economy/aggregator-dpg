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
import { bulkUploadRawKey } from '@aggregator-dpg/shared-primitives/object-keys';
import { config, signedUrlTtlSeconds } from '../../config.js';

// Two S3 clients are kept on this module:
//   - `getInternalClient()` uses S3_ENDPOINT (e.g. http://minio:9000 inside
//     docker, or the AWS regional endpoint in prod). All server-side calls
//     (HEAD, PUT for QR + errors.csv, GET for the worker's CSV download)
//     route through here.
//   - `getPresignerClient()` uses S3_PUBLIC_ENDPOINT — the host the BROWSER
//     can reach. Pre-signed URLs encode the endpoint, so they MUST be minted
//     against the public hostname or browsers see DNS errors. Defaults to
//     S3_ENDPOINT when S3_PUBLIC_ENDPOINT is unset (single-host dev).
let cachedInternalClient: S3Client | null = null;
let cachedPresignerClient: S3Client | null = null;

function buildClient(endpoint: string | undefined): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    ...(endpoint ? { endpoint } : {}),
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
}

function getInternalClient(): S3Client {
  if (cachedInternalClient) return cachedInternalClient;
  cachedInternalClient = buildClient(config.S3_ENDPOINT);
  return cachedInternalClient;
}

function getPresignerClient(): S3Client {
  if (cachedPresignerClient) return cachedPresignerClient;
  const publicEndpoint = config.S3_PUBLIC_ENDPOINT || config.S3_ENDPOINT;
  cachedPresignerClient = buildClient(publicEndpoint);
  return cachedPresignerClient;
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
  const key = bulkUploadRawKey(opts.aggregatorId, opts.uploadId);
  const command = new PutObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ContentType: 'text/csv',
  });
  const url = await getSignedUrl(getPresignerClient(), command, {
    expiresIn: signedUrlTtlSeconds.bulkUpload,
  });
  const expiresAt = new Date(Date.now() + signedUrlTtlSeconds.bulkUpload * 1000).toISOString();
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
    const result = await getInternalClient().send(
      new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
    );
    if (!result.ETag) return null;
    return {
      etag: result.ETag.replaceAll('"', ''),
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
  await getInternalClient().send(
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
 * Carries its own TTL class (`errorsCsvDownload`) rather than borrowing the
 * upload's: an operator lengthening the upload window for a slow link must not
 * silently lengthen how long a leaked download URL stays live.
 *
 * @param key - Object key, already checked against the caller's signing
 *   allow-list. This function does NOT authorize — never pass it a key taken
 *   straight from a request or an unvalidated column.
 */
export async function signErrorsCsvDownloadUrl(key: string): Promise<SignedDownloadUrl> {
  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ResponseContentDisposition: 'attachment; filename="errors.csv"',
    ResponseContentType: 'text/csv',
  });
  const url = await getSignedUrl(getPresignerClient(), command, {
    expiresIn: signedUrlTtlSeconds.errorsCsvDownload,
  });
  const expiresAt = new Date(
    Date.now() + signedUrlTtlSeconds.errorsCsvDownload * 1000,
  ).toISOString();
  return { url, key, expiresAt };
}

/**
 * Issues a pre-signed GET URL for a QR PNG.
 *
 * Minted per click by `GET /v1/links/:id/qr` and redirected to, so the URL is
 * seconds old when the browser follows it. It is a bearer credential for that
 * object: never persist it, never serialise it into a list response, never log
 * it.
 *
 * @param key - Object key for a link the caller has been shown to own.
 */
export async function signQrDownloadUrl(key: string): Promise<SignedDownloadUrl> {
  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ResponseContentType: 'image/png',
  });
  const url = await getSignedUrl(getPresignerClient(), command, {
    expiresIn: signedUrlTtlSeconds.qrDownload,
  });
  const expiresAt = new Date(Date.now() + signedUrlTtlSeconds.qrDownload * 1000).toISOString();
  return { url, key, expiresAt };
}

/** Test-only — clears the cached clients so fresh instances are built next call. */
export function _resetObjectStorageClient(): void {
  cachedInternalClient = null;
  cachedPresignerClient = null;
}
