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
  /**
   * Signalstack organisation id returned by `POST /admin/aggregator/upsert`.
   * Mirror of the `signalstack_org_id` Keycloak user attribute. NULL until
   * the admin-approval flow (or the login-time backfill in `requireApproved`)
   * records it. Worker rows + anonymous link submissions read this column to
   * source the per-call `x-acting-org-id` header.
   */
  signalstackOrgId: string | null;
  /**
   * Parent org this coordinator belongs to (spec §5.2). FK → `aggregator_orgs.id`.
   * The SINGLE authority for the org→coordinator link (spec A1). `null` = flat
   * coordinator (flag off) or legacy orphan; only populated when the org
   * hierarchy is enabled.
   */
  parentOrgId: string | null;
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
  /** Optional parent org id (spec §5.2). Defaults to null when omitted. */
  parentOrgId?: string | null;
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
  parentOrgId?: string | null;
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
  /**
   * Returns every coordinator (`aggregators` row) whose `parent_org_id`
   * matches the given org id — the spec §10 org-view query. `parent_org_id`
   * is the single authority for the org→coordinator link (spec A1).
   *
   * @param orgId - `aggregator_orgs.id`.
   * @returns The org's coordinators (possibly empty); never throws.
   */
  abstract findByParentOrgId(orgId: string): Promise<StoreResult<Aggregator[]>>;
  abstract list(filter: ListAggregatorsFilter): Promise<StoreResult<ListAggregatorsPage>>;
  abstract update(id: string, patch: UpdateAggregatorPatch): Promise<StoreResult<Aggregator>>;
  abstract updateStatus(
    id: string,
    status: AggregatorStatus,
    updatedBy: string,
  ): Promise<StoreResult<Aggregator>>;
  /**
   * Stamps the signalstack organisation id on an aggregator row.
   *
   * Called by both the admin-approval flow (right after the signalstack
   * aggregator upsert returns) and the login-time backfill helper in
   * `requireApproved`. Idempotent: re-writing the same value is a no-op,
   * so repeated approvals/backfills do not bump audit fields meaningfully.
   *
   * @param id - Aggregator UUID.
   * @param signalstackOrgId - Org id returned by the upsert call.
   * @param updatedBy - Audit field; the actor that triggered the write.
   */
  abstract updateSignalstackOrgId(
    id: string,
    signalstackOrgId: string,
    updatedBy: string,
  ): Promise<StoreResult<Aggregator>>;
  abstract deleteById(id: string): Promise<StoreResult<void>>;
}
