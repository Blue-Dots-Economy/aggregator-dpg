/**
 * Public surface and factory for the actor resolver. Returns a process-wide
 * singleton; tests override it with `_setActorResolver`.
 */

import type { ActorResolverBase } from './interface.js';
import { PostgresActorResolver } from './postgres.js';

let instance: ActorResolverBase | null = null;

/** Returns the shared actor resolver (lazy). */
export function getActorResolver(): ActorResolverBase {
  instance ??= new PostgresActorResolver();
  return instance;
}

/** Test helper — replace the singleton. */
export function _setActorResolver(r: ActorResolverBase | null): void {
  instance = r;
}

export { ActorResolverBase, DEFAULT_ORG_PLACEHOLDER } from './interface.js';
export type {
  ActorResolverError,
  ActorResolverResult,
  ResolvedActor,
  ResolvedOrg,
  TokenIdentity,
} from './interface.js';
export { InMemoryActorResolver } from './memory.js';
export { PostgresActorResolver } from './postgres.js';
