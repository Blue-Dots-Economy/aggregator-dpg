import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { UpstreamError, type BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok, type Result } from '@aggregator-dpg/shared-primitives/result';
import { checkRef } from '../../areas.js';
import type { StorageConfig } from '../../config.js';
import {
  ObjectStorageBase,
  type CreateDownloadInput,
  type CreateUploadInput,
  type DownloadUrl,
  type ObjectRef,
  type ObjectStat,
  type PutInput,
  type UploadInstructions,
} from '../../interface.js';

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}

function failed(op: string, cause: unknown): Result<never, BaseError> {
  return err(new UpstreamError(`object storage ${op} failed`, { cause }));
}

export class S3ObjectStorage extends ObjectStorageBase {
  private readonly client: S3Client;
  private readonly presigner: S3Client;

  constructor(private readonly cfg: StorageConfig) {
    super();
    this.client = this.buildClient(cfg.S3_ENDPOINT);
    this.presigner = this.buildClient(cfg.S3_PUBLIC_ENDPOINT || cfg.S3_ENDPOINT);
  }

  private buildClient(endpoint: string | undefined): S3Client {
    const { cfg } = this;
    return new S3Client({
      region: cfg.S3_REGION,
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      maxAttempts: cfg.STORAGE_MAX_ATTEMPTS,
      requestHandler: { connectionTimeout: cfg.STORAGE_CONNECT_TIMEOUT_MS },
      ...(cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: cfg.S3_ACCESS_KEY_ID,
              secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
  }

  async createUpload(input: CreateUploadInput): Promise<Result<UploadInstructions, BaseError>> {
    const stored = checkRef(input.ref);
    if (!stored.success) return stored;
    try {
      const { url, fields } = await createPresignedPost(this.presigner, {
        Bucket: this.cfg.S3_BUCKET,
        Key: stored.value,
        Conditions: [
          ['content-length-range', 0, input.maxBytes],
          ['eq', '$Content-Type', input.contentType],
        ],
        Fields: { 'Content-Type': input.contentType },
        Expires: input.expiresInSeconds,
      });
      return ok({
        method: 'POST',
        url,
        headers: {},
        formFields: fields,
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
      });
    } catch (cause) {
      return failed('createUpload', cause);
    }
  }

  async createDownloadUrl(input: CreateDownloadInput): Promise<Result<DownloadUrl, BaseError>> {
    const stored = checkRef(input.ref);
    if (!stored.success) return stored;
    try {
      const url = await getSignedUrl(
        this.presigner,
        new GetObjectCommand({
          Bucket: this.cfg.S3_BUCKET,
          Key: stored.value,
          ResponseContentDisposition: `attachment; filename="${input.filename}"`,
          ResponseContentType: input.contentType,
        }),
        { expiresIn: input.expiresInSeconds },
      );
      return ok({
        url,
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
      });
    } catch (cause) {
      return failed('createDownloadUrl', cause);
    }
  }

  async stat(ref: ObjectRef): Promise<Result<ObjectStat | null, BaseError>> {
    const stored = checkRef(ref);
    if (!stored.success) return stored;
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: stored.value }),
      );
      if (!head.ETag) return ok(null);
      return ok({
        size: typeof head.ContentLength === 'number' ? head.ContentLength : 0,
        fingerprint: head.ETag.replaceAll('"', ''),
      });
    } catch (cause) {
      const name = errorName(cause);
      if (name === 'NotFound' || name === 'NoSuchKey') return ok(null);
      return failed('stat', cause);
    }
  }

  async openReadStream(ref: ObjectRef): Promise<Result<Readable | null, BaseError>> {
    const stored = checkRef(ref);
    if (!stored.success) return stored;
    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: stored.value }),
      );
      if (!(object.Body instanceof Readable)) {
        return failed('openReadStream', new Error('object body is not a Node stream'));
      }
      return ok(object.Body);
    } catch (cause) {
      if (errorName(cause) === 'NoSuchKey') return ok(null);
      return failed('openReadStream', cause);
    }
  }

  async put(input: PutInput): Promise<Result<void, BaseError>> {
    const stored = checkRef(input.ref);
    if (!stored.success) return stored;
    const params = {
      Bucket: this.cfg.S3_BUCKET,
      Key: stored.value,
      ContentType: input.contentType,
    };
    try {
      if (Buffer.isBuffer(input.body)) {
        await this.client.send(new PutObjectCommand({ ...params, Body: input.body }), {
          abortSignal: AbortSignal.timeout(this.cfg.STORAGE_WRITE_TIMEOUT_MS),
        });
      } else {
        await new Upload({
          client: this.client,
          params: { ...params, Body: input.body },
        }).done();
      }
      return ok(undefined);
    } catch (cause) {
      return failed('put', cause);
    }
  }

  async delete(ref: ObjectRef): Promise<Result<void, BaseError>> {
    const stored = checkRef(ref);
    if (!stored.success) return stored;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: stored.value }),
      );
      return ok(undefined);
    } catch (cause) {
      return failed('delete', cause);
    }
  }

  async checkHealth(): Promise<Result<void, BaseError>> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.S3_BUCKET }));
      return ok(undefined);
    } catch (cause) {
      return failed('checkHealth', cause);
    }
  }
}
