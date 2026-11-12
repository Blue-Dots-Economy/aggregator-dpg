import { ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok, type Result } from '@aggregator-dpg/shared-primitives/result';
import type { ObjectRef, StorageArea } from './interface.js';

export const AREAS: Readonly<Record<StorageArea, { prefix: string; visibility: 'private' }>> = {
  'bulk-uploads': { prefix: 'bulk-uploads/', visibility: 'private' },
  exports: { prefix: 'campaign-exports/', visibility: 'private' },
};

/** Builds a new object key `<area prefix><ownerId>/<segments>`; every key starts with its owner. */
export function buildKey(area: StorageArea, ownerId: string, ...segments: string[]): string {
  return `${AREAS[area].prefix}${[ownerId, ...segments].join('/')}`;
}

/** Returns the ref's key, or a ValidationError when the area is unknown or the key lies outside it. */
export function checkRef(ref: ObjectRef): Result<string, ValidationError> {
  if (!Object.hasOwn(AREAS, ref.area)) {
    return err(new ValidationError(`Unknown storage area: ${String(ref.area)}`));
  }
  const { prefix } = AREAS[ref.area];
  if (!ref.key.startsWith(prefix) || ref.key.length === prefix.length) {
    return err(new ValidationError(`Key is not inside the ${ref.area} area`));
  }
  return ok(ref.key);
}
