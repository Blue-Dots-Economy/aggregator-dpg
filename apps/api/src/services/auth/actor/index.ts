/**
 * Public surface and factory for the actor resolver, in the aggregator API
 * (`@aggregator-dpg/api`). The singleton lives in `resolver.ts`.
 */

export { getActorResolver, _setActorResolver } from './resolver.js';
export { ActorResolverBase } from './interface.js';
export type {
  Actor,
  ActorOrg,
  ActorOrgRelation,
  ActorResolveError,
  ActorResult,
  ResolveActorInput,
} from './interface.js';
export { StoreActorResolver } from './store.js';
export { isNetworkAdmin, ownedOrgIds } from './facts.js';
export { requireActor, type ResolvedCaller } from './require.js';
export { ActorResolverFake, buildAdminActor } from './testing.js';
