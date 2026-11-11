import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import type { StorageConfig } from './config.js';
import type { ObjectStorageBase } from './interface.js';
import { S3ObjectStorage } from './s3.js';

export * from './interface.js';
export * from './areas.js';

let instance: ObjectStorageBase | null = null;

/** Builds the configured provider once and stores it for getObjectStorage. */
export function initObjectStorage(cfg: StorageConfig): ObjectStorageBase {
  instance ??= new S3ObjectStorage(cfg);
  return instance;
}

/**
 * Returns the provider built by initObjectStorage.
 *
 * @throws {ConfigError} When initObjectStorage has not been called.
 */
export function getObjectStorage(): ObjectStorageBase {
  if (!instance) throw new ConfigError('object storage not initialised');
  return instance;
}

/** Replaces the provider, or clears it with null; for tests. */
export function _setObjectStorage(storage: ObjectStorageBase | null): void {
  instance = storage;
}
