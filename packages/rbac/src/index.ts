/**
 * Entry point of `@aggregator-dpg/rbac` for apps that wire concrete engines.
 *
 * Packages must import from `./interface` or `./testing` instead
 * (dependency-cruiser enforces it).
 *
 * @module @aggregator-dpg/rbac
 */

export * from './interface.js';
export { NOT_GRANTABLE, USER_GRANTABLE, SENSITIVE } from './catalogue.js';
export { evaluate, listCapabilities } from './evaluate.js';
export { OpaAuthorizer } from './opa/index.js';
export type { OpaAuthorizerOptions } from './opa/index.js';
export { InMemoryAuthorizer } from './in-memory/index.js';
export {
  RbacConfigSchema,
  parseRbacConfig,
  roleCapabilities,
  orgCapabilities,
} from './rbac-config.js';
export type { RbacConfig } from './rbac-config.js';
export { loadRbacConfig } from './fs/index.js';
export type { LoadedRbacConfig } from './fs/index.js';
