/**
 * Public surface of RBAC in `@aggregator-dpg/api`: boot-time init, the route
 * guard, and the actor resolver.
 */

export { initRbac, getRbacRuntime, rbacConfigCandidates, _setRbacRuntime } from './runtime.js';
export type { RbacMode, RbacRuntime } from './runtime.js';
export { requirePermission } from './guard.js';
export type { GuardOutcome, GuardRequest } from './guard.js';
export {
  assertRouteDeclared,
  callerFromAny,
  callerFromAuth,
  enforceRouteAccess,
  isServiceAccount,
  listDeclaredRoutes,
} from './route-access.js';
export type { RouteAccess, RouteCaller } from './route-access.js';
export * from './actor-resolver/index.js';
