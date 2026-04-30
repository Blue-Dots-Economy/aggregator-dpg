/**
 * Aggregator store contract.
 *
 * Persistence port for the `aggregators` table. Holds org-level data only —
 * no PII. Concrete adapters: Postgres for production, in-memory for tests.
 */

import type { AggregatorType } from '../../db/schema-types.js';

export interface Aggregator {
  id: string;
  orgSlug: string;
  type: AggregatorType;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAggregatorInput {
  orgSlug: string;
  type: AggregatorType;
}

export type StoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'DUPLICATE_SLUG'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: StoreError };

/**
 * Abstract aggregator persistence port.
 *
 * Concrete implementations must implement every method. No partial impls,
 * no `throw new Error('not implemented')` — return correct empty/error
 * results instead.
 */
export abstract class AggregatorStoreBase {
  abstract create(input: CreateAggregatorInput): Promise<StoreResult<Aggregator>>;
  abstract findById(id: string): Promise<StoreResult<Aggregator | null>>;
  abstract findBySlug(orgSlug: string): Promise<StoreResult<Aggregator | null>>;
  abstract deleteById(id: string): Promise<StoreResult<void>>;
}
