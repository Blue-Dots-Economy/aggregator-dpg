/**
 * S3 client for the worker. Downloads CSV files for the File Processor,
 * uploads errors.csv artefacts for the Finaliser, and (for the campaign PII
 * export job) uploads the export CSV and mints its pre-signed download link.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { config } from './config.js';

// Two clients, mirroring the API's object-storage split:
//   - `getClient()` uses the internal `S3_ENDPOINT` for all server-side calls
//     (GET/PUT). Carries the connect-timeout + retry posture.
//   - `getPresignerClient()` uses the browser-reachable `S3_PUBLIC_ENDPOINT`
//     (falling back to `S3_ENDPOINT`). Pre-signed URLs encode the endpoint, so
//     an export link must be minted against the public host or an email-client
//     browser sees a DNS error.
let cachedClient: S3Client | null = null;
let cachedPresignerClient: S3Client | null = null;

/** Bound the TCP-connect phase so a black-holed endpoint fails fast. */
const S3_CONNECTION_TIMEOUT_MS = 5_000;
/** Total attempts per request (1 initial + retries) using the SDK's backoff. */
const S3_MAX_ATTEMPTS = 3;
/**
 * Wall-clock bound for a single upload attempt. The client itself sets only a
 * connect timeout (a streaming GetObject must never be cut off mid-download),
 * so an upload that connects and then stalls has nothing to stop it — the job
 * would hold its worker slot until the queue's stall timeout. Uploads are
 * bounded per-call instead, which leaves the shared GET path untouched.
 */
const S3_UPLOAD_TIMEOUT_MS = 60_000;

function buildClient(endpoint: string | undefined): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    // Explicit retry + connect timeout per error-handling.md. Only the connect
    // phase is bounded — not a request/body timeout — so a large streaming
    // GetObject download is never aborted mid-stream.
    maxAttempts: S3_MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: S3_CONNECTION_TIMEOUT_MS },
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

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = buildClient(config.S3_ENDPOINT);
  return cachedClient;
}

function getPresignerClient(): S3Client {
  if (cachedPresignerClient) return cachedPresignerClient;
  cachedPresignerClient = buildClient(config.S3_PUBLIC_ENDPOINT || config.S3_ENDPOINT);
  return cachedPresignerClient;
}

/**
 * Returns the CSV object body as a Node `Readable` without buffering it.
 *
 * The File Processor parses this stream incrementally (see
 * `jobs/bulk-file-stream.ts`) so the worker never holds the whole file in
 * memory and the parse yields to the event loop between network chunks. The
 * caller owns the stream and must consume or destroy it.
 *
 * @param s3Key - Key of the uploaded CSV object.
 * @returns The object body as a Node `Readable`.
 * @throws {Error} If the object has no body.
 */
export async function getCsvStream(s3Key: string): Promise<Readable> {
  const result = await getClient().send(
    new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: s3Key }),
  );
  const body = result.Body;
  if (!body) {
    throw new Error(`empty body for s3 key: ${s3Key}`);
  }
  // In the Node runtime the AWS SDK returns a Node.js Readable.
  return body as Readable;
}

/**
 * Uploads an artefact to S3. Used by the Finaliser to write
 * `bulk-uploads/{upload_id}/errors.csv` at a deterministic key — replays of
 * the Finaliser overwrite identical bytes.
 */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const abort = AbortSignal.timeout(S3_UPLOAD_TIMEOUT_MS);
  await getClient().send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
    { abortSignal: abort },
  );
}

export interface SignedDownloadUrl {
  url: string;
  key: string;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
}

/**
 * Issues a pre-signed GET URL for a participant-export CSV (aggregator-dpg#579).
 *
 * Signed against the browser-reachable presigner client and served as an
 * attachment; TTL is `EXPORT_URL_TTL_SECONDS`. Delivered by email to the
 * requesting aggregator's contact email — never returned to the export caller.
 *
 * @param key - The S3 object key of the export CSV.
 * @returns The signed URL, its key, and an ISO expiry timestamp.
 */
export async function signExportDownloadUrl(key: string): Promise<SignedDownloadUrl> {
  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ResponseContentDisposition: 'attachment; filename="participant-export.csv"',
    ResponseContentType: 'text/csv',
  });
  const url = await getSignedUrl(getPresignerClient(), command, {
    expiresIn: config.EXPORT_URL_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + config.EXPORT_URL_TTL_SECONDS * 1000).toISOString();
  return { url, key, expiresAt };
}

/** Test-only — clears cached clients so fresh instances are built next call. */
export function _resetObjectStorageClient(): void {
  cachedClient = null;
  cachedPresignerClient = null;
}
