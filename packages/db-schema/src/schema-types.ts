/**
 * String-literal types mirroring the DB enums in `schema.ts`.
 * Re-exported for downstream services that don't want to pull in the full
 * Drizzle schema module.
 */

export type AggregatorActorType = 'aggregator' | 'seeker' | 'provider';

/**
 * App-layer signup + JWT claim only ever set `seeker` or `provider`. The
 * DB enum still carries the legacy `'both'` value (see migration backlog) so
 * the type union mirrors what the column may yield on read; new writes are
 * narrowed to {@link AggregatorRoleType} via the app-layer Zod schema.
 */
export type AggregatorRoleType = 'seeker' | 'provider' | 'both';

export type AggregatorStatus = 'pending' | 'active' | 'inactive' | 'retired';

/** @deprecated Use {@link AggregatorRoleType}. Kept temporarily until callers migrate. */
export type AggregatorType = AggregatorRoleType;
