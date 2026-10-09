/**
 * String-literal types mirroring the DB enums in `schema.ts`.
 * Re-exported for downstream services that don't want to pull in the full
 * Drizzle schema module.
 */

export type AggregatorActorType = 'aggregator' | 'seeker' | 'provider';

export type AggregatorStatus = 'pending' | 'active' | 'inactive' | 'retired';
