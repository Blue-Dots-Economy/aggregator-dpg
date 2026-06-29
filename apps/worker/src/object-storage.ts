/**
 * S3 client for the worker. Downloads CSV files for the File Processor and
 * uploads errors.csv artefacts for the Finaliser.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { config } from './config.js';

let cachedClient: S3Client | null = null;

/** Bound the TCP-connect phase so a black-holed endpoint fails fast. */
const S3_CONNECTION_TIMEOUT_MS = 5_000;
/** Total attempts per request (1 initial + retries) using the SDK's backoff. */
const S3_MAX_ATTEMPTS = 3;

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    region: config.S3_REGION,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
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
  return cachedClient;
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
  await getClient().send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}
