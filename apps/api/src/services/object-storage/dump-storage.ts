/**
 * S3 reads for the non-PII campaign dump (`@aggregator-dpg/api`).
 *
 * The dump objects are written by the Signals `signals-s3-export` cron under
 * `[<prefix>/]<network>/<instance_id>/`, outside the areas the shared
 * `@aggregator-dpg/object-storage` package manages, so the dump route reads them
 * here: a HEAD to confirm each object exists and a pre-signed GET URL for the
 * campaign manager to download it. Works with S3 and MinIO; MinIO needs
 * `S3_ENDPOINT` and path-style addressing. Uses the same `S3_*` / `STORAGE_*`
 * settings as the shared package.
 */

import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../config.js';

// Two S3 clients:
//   - `getInternalClient()` uses S3_ENDPOINT for server-side calls (HEAD).
//   - `getPresignerClient()` uses S3_PUBLIC_ENDPOINT, the host the campaign
//     manager can reach; pre-signed URLs must use it. Defaults to S3_ENDPOINT.
let cachedInternalClient: S3Client | null = null;
let cachedPresignerClient: S3Client | null = null;

function buildClient(endpoint: string | undefined): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    // Only the connect phase has a timeout; retries use the SDK's backoff.
    maxAttempts: config.STORAGE_MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: config.STORAGE_CONNECT_TIMEOUT_MS },
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
  cachedInternalClient ??= buildClient(config.S3_ENDPOINT);
  return cachedInternalClient;
}

function getPresignerClient(): S3Client {
  cachedPresignerClient ??= buildClient(config.S3_PUBLIC_ENDPOINT || config.S3_ENDPOINT);
  return cachedPresignerClient;
}

/** What a HEAD on a dump object returns. */
export interface ObjectHead {
  etag: string;
  contentLength: number;
  /**
   * S3 `LastModified`, if S3 returns it. The dump route reports it per object
   * so consumers can detect a run caught mid-write.
   */
  lastModified?: Date;
}

/**
 * HEADs a dump object to confirm it exists and read its size and ETag.
 *
 * @param key - The S3 object key.
 * @returns The object's metadata, or null when it does not exist.
 * @throws The SDK error on any transport failure, so the caller can surface 503.
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
      ...(result.LastModified ? { lastModified: result.LastModified } : {}),
    };
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
    // S3 returns NotFound or NoSuchKey for missing objects.
    if (code === 'NotFound' || code === 'NoSuchKey') return null;
    throw err;
  }
}

/** A pre-signed GET URL for one object. */
export interface SignedDownloadUrl {
  url: string;
  key: string;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
}

/**
 * Issues a pre-signed GET URL for a dump object, signed against the public
 * endpoint since the caller is outside the cluster.
 *
 * @param key - The S3 object key to grant GET access to.
 * @param opts.ttlSeconds - URL lifetime in seconds.
 * @param opts.contentType - Optional response Content-Type override.
 * @param opts.contentDisposition - Optional response Content-Disposition.
 * @returns The signed URL with its key and ISO 8601 expiry.
 */
export async function signDownloadUrl(
  key: string,
  opts: { ttlSeconds: number; contentType?: string; contentDisposition?: string },
): Promise<SignedDownloadUrl> {
  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
    ...(opts.contentDisposition ? { ResponseContentDisposition: opts.contentDisposition } : {}),
  });
  const url = await getSignedUrl(getPresignerClient(), command, { expiresIn: opts.ttlSeconds });
  const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000).toISOString();
  return { url, key, expiresAt };
}

/** Test-only: clears the cached clients so fresh instances are built on the next call. */
export function _resetDumpStorageClients(): void {
  cachedInternalClient = null;
  cachedPresignerClient = null;
}
