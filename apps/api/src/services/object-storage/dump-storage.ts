/**
 * S3 reads for the campaign dump (`@aggregator-dpg/api`): HEAD and pre-signed GET.
 * The dump keys sit outside the shared object-storage package's areas; same `S3_*` settings.
 */

// TODO(Blue-Dots-Economy/agg-campaign-manager-v2#5): remove with the dump once every deployment
// syncs straight to the Campaign Manager; until then this bypasses @aggregator-dpg/object-storage.

import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../config.js';

// HEAD goes to S3_ENDPOINT; URLs are signed for S3_PUBLIC_ENDPOINT, the host the caller reaches.
let cachedInternalClient: S3Client | null = null;
let cachedPresignerClient: S3Client | null = null;

function buildClient(endpoint: string | undefined): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
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
  lastModified?: Date;
}

/**
 * HEADs a dump object.
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
    if (code === 'NotFound' || code === 'NoSuchKey') return null;
    throw err;
  }
}

/** A pre-signed GET URL for one object. */
export interface SignedDownloadUrl {
  url: string;
  key: string;
  expiresAt: string;
}

/**
 * Issues a pre-signed GET URL for a dump object.
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

/** Test-only: clears the cached clients. */
export function _resetDumpStorageClients(): void {
  cachedInternalClient = null;
  cachedPresignerClient = null;
}
