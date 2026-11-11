import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { storageConfigFields } from '../../../config.js';
import { runObjectStorageContract } from '../../../contract-suite.js';
import { S3ObjectStorage } from '../s3.js';

const endpoint = process.env.OBJECT_STORAGE_IT_ENDPOINT;
const BUCKET = 'os-contract-it';

describe.skipIf(!endpoint)('S3ObjectStorage against a live S3-compatible endpoint', () => {
  const cfg = z.object(storageConfigFields).parse({
    STORAGE_PROVIDER: 's3',
    S3_ENDPOINT: endpoint,
    S3_FORCE_PATH_STYLE: 'true',
    S3_BUCKET: BUCKET,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  });

  beforeAll(async () => {
    const admin = new S3Client({
      region: cfg.S3_REGION,
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: cfg.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: cfg.S3_SECRET_ACCESS_KEY ?? '',
      },
    });
    await admin
      .send(new CreateBucketCommand({ Bucket: BUCKET }))
      .catch((error: { name?: string }) => {
        if (error.name !== 'BucketAlreadyOwnedByYou') throw error;
      });
  });

  runObjectStorageContract('s3 (MinIO)', async () => {
    const storage = new S3ObjectStorage(cfg);
    return {
      storage,
      seed: async (ref, bytes) => {
        const result = await storage.put({ ref, body: bytes, contentType: 'text/csv' });
        if (!result.success) throw result.error;
      },
    };
  });

  it('serves a download URL with the bytes and an attachment filename', async () => {
    const storage = new S3ObjectStorage(cfg);
    const ref = { area: 'bulk-uploads', key: `contract/${randomUUID()}/errors.csv` } as const;
    const bytes = Buffer.from('row,error\n1,bad\n');
    const put = await storage.put({ ref, body: bytes, contentType: 'text/csv' });
    if (!put.success) throw put.error;
    try {
      const download = await storage.createDownloadUrl({
        ref,
        expiresInSeconds: 60,
        filename: 'upload-errors.csv',
        contentType: 'text/csv',
      });
      if (!download.success) throw download.error;
      const response = await fetch(download.value.url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="upload-errors.csv"',
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await storage.delete(ref);
    }
  });
});
