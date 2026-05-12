/**
 * Aggregator store contract.
 *
 * Persistence port for the `aggregators` table — the registration-essential
 * row that an aggregator has after signup. The secondary 1:1 row lives in
 * `aggregator_profile` and is owned by the AggregatorProfileStore.
 *
 * Concrete adapters: Postgres for production, in-memory for tests. PII
 * (phone/email) is mirrored from Keycloak; this store treats both as ordinary
 * indexed columns for login-path lookups.
 */

import type {
  ActorType,
  AggregatorStatus,
  BecknContact,
  BecknLocation,
  ConsentRecord,
  RoleType,
} from '@aggregator-dpg/shared-primitives/aggregator';

export interface Aggregator {
  id: string;
  orgSlug: string;
  actorType: ActorType;
  name: string;
  type: RoleType | null;
  url: string | null;
  contact: BecknContact;
  contactPhone: string;
  contactEmail: string;
  locations: BecknLocation[];
  consent: ConsentRecord;
  status: AggregatorStatus;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAggregatorInput {
  orgSlug: string;
  actorType: ActorType;
  name: string;
  type: RoleType | null;
  url?: string | null;
  contact: BecknContact;
  locations?: BecknLocation[];
  consent: ConsentRecord;
  createdBy: string;
  updatedBy: string;
}

/**
 * Patch shape for updates. `orgSlug` is intentionally absent — the DB trigger
 * `aggregators_lock_slug` rejects any attempt to mutate the slug. Identity
 * (`id`) and audit timestamps are server-managed too.
 */
export interface UpdateAggregatorPatch {
  name?: string;
  type?: RoleType | null;
  url?: string | null;
  contact?: BecknContact;
  locations?: BecknLocation[];
  consent?: ConsentRecord;
  status?: AggregatorStatus;
  updatedBy: string;
}

export interface ListAggregatorsFilter {
  limit?: number;
  offset?: number;
  status?: AggregatorStatus;
  actorType?: ActorType;
}

export interface ListAggregatorsPage {
  rows: Aggregator[];
  total: number;
}

export type StoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'DUPLICATE_SLUG'; message: string }
  | { code: 'DUPLICATE_PHONE'; message: string }
  | { code: 'DUPLICATE_EMAIL'; message: string }
  | { code: 'CHECK_VIOLATION'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: StoreError };

/**
 * Abstract aggregator persistence port. Concrete implementations must
 * implement every method (no partial stubs). Returns Result<T,StoreError> on
 * every boundary — never throws.
 */
export abstract class AggregatorStoreBase {
  abstract create(input: CreateAggregatorInput): Promise<StoreResult<Aggregator>>;
  abstract findById(id: string): Promise<StoreResult<Aggregator | null>>;
  abstract findBySlug(orgSlug: string): Promise<StoreResult<Aggregator | null>>;
  abstract findByContactPhone(phone: string): Promise<StoreResult<Aggregator | null>>;
  abstract findByContactEmail(email: string): Promise<StoreResult<Aggregator | null>>;
  abstract list(filter: ListAggregatorsFilter): Promise<StoreResult<ListAggregatorsPage>>;
  abstract update(id: string, patch: UpdateAggregatorPatch): Promise<StoreResult<Aggregator>>;
  abstract updateStatus(
    id: string,
    status: AggregatorStatus,
    updatedBy: string,
  ): Promise<StoreResult<Aggregator>>;
  abstract deleteById(id: string): Promise<StoreResult<void>>;
}
