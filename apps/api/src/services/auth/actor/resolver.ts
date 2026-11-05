/**
 * Process-wide actor resolver singleton, in the aggregator API
 * (`@aggregator-dpg/api`). Tests override it with `_setActorResolver`.
 */

import type { ActorResolverBase } from './interface.js';
import { StoreActorResolver } from './store.js';

let instance: ActorResolverBase | null = null;

/** Returns the shared actor resolver (lazy). */
export function getActorResolver(): ActorResolverBase {
  instance ??= new StoreActorResolver();
  return instance;
}

/** Test helper — replace the singleton (`null` restores the default). */
export function _setActorResolver(r: ActorResolverBase | null): void {
  instance = r;
}
