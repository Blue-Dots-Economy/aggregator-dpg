/**
 * Public surface + factory for the identity store. Returns a process-wide
 * singleton; tests override it with `_setIdentityStore`.
 */

import type { IdentityStoreBase } from './interface.js';
import { PostgresIdentityStore } from './postgres.js';

let instance: IdentityStoreBase | null = null;

/** Returns the shared identity store (lazy). */
export function getIdentityStore(): IdentityStoreBase {
  instance ??= new PostgresIdentityStore();
  return instance;
}

/** Test helper — replace the singleton. */
export function _setIdentityStore(s: IdentityStoreBase | null): void {
  instance = s;
}

export { IdentityStoreBase } from './interface.js';
export type { IdentityStoreError, IdentityStoreResult, LinkOutcome } from './interface.js';
export { InMemoryIdentityStore } from './memory.js';
export { PostgresIdentityStore } from './postgres.js';
