import { ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok, type Result } from '@aggregator-dpg/shared-primitives/result';
import type { ObjectRef, StorageArea } from './interface.js';

export const AREAS: Readonly<Record<StorageArea, { prefix: string; visibility: 'private' }>> = {
  'bulk-uploads': { prefix: 'bulk-uploads/', visibility: 'private' },
  exports: { prefix: 'campaign-exports/', visibility: 'private' },
};

/** Returns the full stored key: the area prefix followed by the relative key. */
export function toStoredKey(ref: ObjectRef): string {
  return AREAS[ref.area].prefix + ref.key;
}

/** Parses a stored key back into a reference; fails when the prefix or remainder is missing. */
export function fromStoredKey(
  area: StorageArea,
  stored: string,
): Result<ObjectRef, ValidationError> {
  const { prefix } = AREAS[area];
  if (!stored.startsWith(prefix) || stored.length === prefix.length) {
    return err(new ValidationError(`Stored key is not a valid ${area} key`));
  }
  return ok({ area, key: stored.slice(prefix.length) });
}
