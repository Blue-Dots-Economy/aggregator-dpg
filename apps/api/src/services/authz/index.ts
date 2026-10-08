/**
 * Public surface of RBAC in `@aggregator-dpg/api`: boot-time init, the
 * capability checks and the route declarations. The actor comes from Phase 5's
 * resolver (`services/auth/actor`); reach from `scope.ts`.
 */

export { initRbac, getRbacRuntime, rbacConfigCandidates, _setRbacRuntime } from './runtime.js';
export type { RbacMode, RbacRuntime } from './runtime.js';
export { checkCapability, decisionInput, requirePermission, resolveCaller } from './guard.js';
export type { GuardOutcome, GuardRequest, TokenIdentity } from './guard.js';
export {
  assertRouteDeclared,
  callerFromAny,
  callerFromAuth,
  enforceActorRouteAccess,
  enforceRouteAccess,
  isServiceAccount,
  listDeclaredRoutes,
} from './route-access.js';
export type { RouteAccess, RouteCaller } from './route-access.js';
