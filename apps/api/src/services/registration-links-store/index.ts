/**
 * Public surface and factory for the registration links store.
 *
 * Returns a process-wide singleton. Tests override via `_setRegistrationLinksStore`.
 */

import type { RegistrationLinksStoreBase } from './interface.js';
import { PostgresRegistrationLinksStore } from './postgres.js';

let instance: RegistrationLinksStoreBase | null = null;

export function getRegistrationLinksStore(): RegistrationLinksStoreBase {
  if (instance) return instance;
  instance = new PostgresRegistrationLinksStore();
  return instance;
}

/** Test helper — replace the singleton. */
export function _setRegistrationLinksStore(s: RegistrationLinksStoreBase | null): void {
  instance = s;
}

export { RegistrationLinksStoreBase } from './interface.js';
export type {
  RegistrationLink,
  RegistrationLinkCompletionAction,
  RegistrationLinkStatus,
  CreateRegistrationLinkInput,
  ListRegistrationLinksOptions,
  ListRegistrationLinksResult,
  StoreError,
  StoreResult,
} from './interface.js';
export { PostgresRegistrationLinksStore } from './postgres.js';
