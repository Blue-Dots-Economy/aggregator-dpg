/**
 * Public API surface re-exports for downstream packages that need typed
 * access to API contracts. The HTTP entrypoint lives in `server.ts`.
 */

export type { Config } from './config.js';
export type { Coordinator } from './services/user-store/index.js';
export { buildApp } from './app.js';
