/**
 * Public surface and factory for the registration store.
 *
 * Returns a process-wide singleton. Tests override via `_setRegistrationStore`.
 */

import type { RegistrationStoreBase } from './interface.js';
import { PostgresRegistrationStore } from './postgres.js';

let instance: RegistrationStoreBase | null = null;

/**
 * Returns the shared registration store. Lazy-initialised on first call.
 */
export function getRegistrationStore(): RegistrationStoreBase {
  if (instance) return instance;
  instance = new PostgresRegistrationStore();
  return instance;
}

/** Test helper — replace the singleton. */
export function _setRegistrationStore(s: RegistrationStoreBase | null): void {
  instance = s;
}

export { RegistrationStoreBase } from './interface.js';
export type {
  Registration,
  CreateRegistrationInput,
  TransitionPatch,
  TransitionMeta,
  RegistrationState,
  RegistrationActor,
  ProvisionKey,
  ProvisionStatus,
  RegistrationStoreError,
  StoreResult,
} from './interface.js';
export { InMemoryRegistrationStore } from './memory.js';
export { PostgresRegistrationStore } from './postgres.js';
export { RegistrationStoreFake, buildRegistration } from './testing.js';
