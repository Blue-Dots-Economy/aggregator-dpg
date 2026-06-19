/**
 * S3 client for the worker. Downloads CSV files for the File Processor and
 * uploads errors.csv artefacts for the Finaliser.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';

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

/**
 * Returns the entire CSV body as a UTF-8 string.
 *
 * For the no-chunking MVP, the body is bounded by `BULK_UPLOAD_MAX_BYTES`
 * (10 MB by default) so a single in-memory read is acceptable.
 */
export async function downloadCsvAsString(s3Key: string): Promise<string> {
  const result = await getClient().send(
    new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: s3Key }),
  );
  const body = result.Body;
  if (!body) {
    throw new Error(`empty body for s3 key: ${s3Key}`);
  }
  // The SDK returns a Node.js Readable for Node runtime.
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
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
