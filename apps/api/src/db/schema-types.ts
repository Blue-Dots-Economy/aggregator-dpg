/**
 * String-literal types mirroring the DB enums in `schema.ts`.
 * Re-exported for downstream services that don't want to pull in the full
 * Drizzle schema module.
 */

export type AggregatorType = 'seeker' | 'provider';
