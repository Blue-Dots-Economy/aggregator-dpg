/**
 * Aggregator profile store contract.
 *
 * Persistence port for the `aggregator_profile` table — the 1:1 secondary
 * row populated post-login. Holds `contact_name`, `personas`, `services`,
 * `verified_certificate`, and a `profile_completed_at` checkpoint stamped
 * when all required fields are filled in. The parent row in `aggregators`
 * is owned by the AggregatorStore.
 */

import type {
  PersonaRef,
  PublicKeyEntry,
  ServiceRef,
} from '@aggregator-dpg/shared-primitives/aggregator';

export interface AggregatorProfile {
  aggregatorId: string;
  contactName: string | null;
  personas: PersonaRef[];
  services: ServiceRef[];
  verifiedCertificate: PublicKeyEntry[];
  profileCompletedAt: Date | null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAggregatorProfileInput {
  aggregatorId: string;
  contactName?: string | null;
  personas?: PersonaRef[];
  services?: ServiceRef[];
  verifiedCertificate?: PublicKeyEntry[];
  createdBy: string;
  updatedBy: string;
}

/**
 * Patch shape for profile updates. Identity (`aggregatorId`) and audit
 * timestamps are server-managed. `profileCompletedAt` is auto-stamped by the
 * caller when all required profile fields are present — the store leaves it
 * alone unless explicitly set.
 */
export interface UpdateAggregatorProfileInput {
  contactName?: string | null;
  personas?: PersonaRef[];
  services?: ServiceRef[];
  verifiedCertificate?: PublicKeyEntry[];
  profileCompletedAt?: Date | null;
  updatedBy: string;
}

export type ProfileStoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'DUPLICATE'; message: string }
  | { code: 'FOREIGN_KEY_VIOLATION'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type ProfileStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProfileStoreError };

/**
 * Abstract aggregator-profile persistence port. Every method returns a
 * `Result<T, ProfileStoreError>` at the boundary — no throws.
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
  abstract markCompleted(
    aggregatorId: string,
    updatedBy: string,
  ): Promise<ProfileStoreResult<AggregatorProfile>>;
  abstract deleteByAggregatorId(aggregatorId: string): Promise<ProfileStoreResult<void>>;
}
