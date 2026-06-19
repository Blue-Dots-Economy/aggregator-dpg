/**
 * Public API surface re-exports for downstream packages that need typed
 * access to API contracts. The HTTP entrypoint lives in `server.ts`.
 */

export type { Config } from './config.js';
export type { AggregatorType } from './db/schema-types.js';
export type { Aggregator } from './services/aggregator-store/index.js';
export type { AggregatorProfile } from './services/aggregator-profile-store/index.js';
export { buildApp } from './app.js';
