/**
 * Aggregator profile store contract.
 *
 * Persistence port for the `aggregator_profiles` table. Each row is owned by
 * an aggregator (1:1 via `aggregator_id` PK). Holds the JSONB `data` and
 * `consent` fields populated post-login during profile completion.
 */

export interface AggregatorProfile {
  aggregatorId: string;
  schemaVersion: number;
  data: Record<string, unknown>;
  consent: Record<string, unknown>;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAggregatorProfileInput {
  aggregatorId: string;
  schemaVersion?: number;
  data?: Record<string, unknown>;
  consent?: Record<string, unknown>;
  createdBy: string;
  updatedBy: string;
}

export interface UpdateAggregatorProfileInput {
  schemaVersion?: number;
  data?: Record<string, unknown>;
  consent?: Record<string, unknown>;
  updatedBy: string;
}

export type ProfileStoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'DUPLICATE'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type ProfileStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProfileStoreError };

/**
 * Abstract aggregator profile persistence port.
 */
export abstract class AggregatorProfileStoreBase {
  abstract create(
    input: CreateAggregatorProfileInput,
  ): Promise<ProfileStoreResult<AggregatorProfile>>;
  abstract findByAggregatorId(
    aggregatorId: string,
  ): Promise<ProfileStoreResult<AggregatorProfile | null>>;
  abstract update(
    aggregatorId: string,
    input: UpdateAggregatorProfileInput,
  ): Promise<ProfileStoreResult<AggregatorProfile>>;
}
