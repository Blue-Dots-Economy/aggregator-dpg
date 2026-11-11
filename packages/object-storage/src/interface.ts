import type { Readable } from 'node:stream';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

/** Logical storage area; each maps to a key prefix. */
export type StorageArea = 'bulk-uploads' | 'exports';

/** Reference to one object; `key` is the full stored key, inside the area prefix. */
export interface ObjectRef {
  area: StorageArea;
  key: string;
}

export interface UploadInstructions {
  method: 'PUT' | 'POST';
  url: string;
  headers: Record<string, string>;
  formFields: Record<string, string>;
  expiresAt: string;
}

export interface CreateUploadInput {
  ref: ObjectRef;
  contentType: string;
  /** Size limit in bytes; without it the instructions are a plain signed PUT with no limit. */
  maxBytes?: number;
  expiresInSeconds: number;
}

export interface CreateDownloadInput {
  ref: ObjectRef;
  expiresInSeconds: number;
  filename: string;
  contentType: string;
}

export interface DownloadUrl {
  url: string;
  expiresAt: string;
}

export interface ObjectStat {
  size: number;
  fingerprint: string;
}

export interface PutInput {
  ref: ObjectRef;
  body: Buffer | Readable;
  contentType: string;
}

/** Object storage contract implemented by every storage provider. */
export abstract class ObjectStorageBase {
  /** Builds browser upload instructions for a single object. */
  abstract createUpload(input: CreateUploadInput): Promise<Result<UploadInstructions, BaseError>>;

  /** Builds a time-limited download URL that saves under the given filename. */
  abstract createDownloadUrl(input: CreateDownloadInput): Promise<Result<DownloadUrl, BaseError>>;

  /** Returns object metadata, or null when the object does not exist. */
  abstract stat(ref: ObjectRef): Promise<Result<ObjectStat | null, BaseError>>;

  /** Opens the object for streaming, or null when the object does not exist. */
  abstract openReadStream(ref: ObjectRef): Promise<Result<Readable | null, BaseError>>;

  /** Writes a buffer or stream to the object, replacing any existing content. */
  abstract put(input: PutInput): Promise<Result<void, BaseError>>;

  /** Deletes the object; succeeds when it is already absent. */
  abstract delete(ref: ObjectRef): Promise<Result<void, BaseError>>;

  /** Verifies the storage backend is reachable and the bucket is accessible. */
  abstract checkHealth(): Promise<Result<void, BaseError>>;
}
