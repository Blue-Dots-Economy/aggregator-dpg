import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { UpstreamError, type BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok, type Result } from '@aggregator-dpg/shared-primitives/result';
import { checkRef } from './areas.js';
import {
  ObjectStorageBase,
  type CreateDownloadInput,
  type CreateUploadInput,
  type DownloadUrl,
  type ObjectRef,
  type ObjectStat,
  type PutInput,
  type UploadInstructions,
} from './interface.js';

interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

async function collect(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** In-memory ObjectStorageBase for tests, with seeding, inspection and one-shot failure injection. */
export class FakeObjectStorage extends ObjectStorageBase {
  private readonly objects = new Map<string, StoredObject>();
  private readonly failures = new Map<keyof ObjectStorageBase, BaseError>();

  /** Stores bytes at the reference without going through put. */
  seed(ref: ObjectRef, bytes: Buffer, contentType = 'application/octet-stream'): void {
    this.objects.set(ref.key, { bytes: Buffer.from(bytes), contentType });
  }

  /** Returns a copy of the stored bytes, or undefined when absent. */
  read(ref: ObjectRef): Buffer | undefined {
    const found = this.objects.get(ref.key);
    return found ? Buffer.from(found.bytes) : undefined;
  }

  /** Makes the next call of the operation return the error once, then behave normally. */
  failNext(op: keyof ObjectStorageBase, error: BaseError): void {
    this.failures.set(op, error);
  }

  private takeFailure(op: keyof ObjectStorageBase): BaseError | undefined {
    const error = this.failures.get(op);
    this.failures.delete(op);
    return error;
  }

  async createUpload(input: CreateUploadInput): Promise<Result<UploadInstructions, BaseError>> {
    const stored = checkRef(input.ref);
    if (!stored.success) return stored;
    const failure = this.takeFailure('createUpload');
    if (failure) return err(failure);
    return ok({
      method: 'PUT',
      url: `fake://${stored.value}`,
      headers: { 'Content-Type': input.contentType },
      formFields: {},
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    });
  }

  async createDownloadUrl(input: CreateDownloadInput): Promise<Result<DownloadUrl, BaseError>> {
    const stored = checkRef(input.ref);
    if (!stored.success) return stored;
    const failure = this.takeFailure('createDownloadUrl');
    if (failure) return err(failure);
    return ok({
      url: `fake://${stored.value}?filename=${encodeURIComponent(input.filename)}`,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    });
  }

  async stat(ref: ObjectRef): Promise<Result<ObjectStat | null, BaseError>> {
    const stored = checkRef(ref);
    if (!stored.success) return stored;
    const failure = this.takeFailure('stat');
    if (failure) return err(failure);
    const found = this.objects.get(stored.value);
    if (!found) return ok(null);
    return ok({
      size: found.bytes.length,
      fingerprint: createHash('sha256').update(found.bytes).digest('hex'),
    });
  }

  async openReadStream(ref: ObjectRef): Promise<Result<Readable | null, BaseError>> {
    const stored = checkRef(ref);
    if (!stored.success) return stored;
    const failure = this.takeFailure('openReadStream');
    if (failure) return err(failure);
    const found = this.objects.get(stored.value);
    return ok(found ? Readable.from([Buffer.from(found.bytes)]) : null);
  }

  async put(input: PutInput): Promise<Result<void, BaseError>> {
    const stored = checkRef(input.ref);
    if (!stored.success) return stored;
    const failure = this.takeFailure('put');
    if (failure) return err(failure);
    try {
      const bytes = await collect(input.body);
      this.objects.set(stored.value, { bytes, contentType: input.contentType });
      return ok(undefined);
    } catch (cause) {
      return err(new UpstreamError('object storage put failed', { cause }));
    }
  }

  async delete(ref: ObjectRef): Promise<Result<void, BaseError>> {
    const stored = checkRef(ref);
    if (!stored.success) return stored;
    const failure = this.takeFailure('delete');
    if (failure) return err(failure);
    this.objects.delete(stored.value);
    return ok(undefined);
  }

  async checkHealth(): Promise<Result<void, BaseError>> {
    const failure = this.takeFailure('checkHealth');
    if (failure) return err(failure);
    return ok(undefined);
  }
}
