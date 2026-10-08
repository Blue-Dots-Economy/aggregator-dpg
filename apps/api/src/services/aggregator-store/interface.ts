/**
 * Aggregator store contract.
 *
 * Persistence port for coordinator rows of the `users` table — the
 * registration-essential row a coordinator has after signup.
 *
 * Concrete adapters: Postgres for production, in-memory for tests. The
 * person's name / email / phone live in the `contact` table (migration 0025),
 * referenced by `contactId`; `contact`, `contactPhone` and `contactEmail` on
 * the record are composed from it so callers see the same Beckn shape as
 * before. Keycloak keeps its own copy of the login identifiers.
 *
 * Org details (migration 0028): `url`, `locations`, `contact.company` and
 * `contact.gstNumber` are RENDERED from the coordinator's org
 * (`organisations`), falling back per field to the coordinator's own values in
 * `legacy_org_details` when the org's is empty. They are never written through
 * this store's update; the org's owner edits them (Phase 5).
 *
 * Consent (migration 0029) lives only in the `consent_record` ledger: `create`
 * writes the registration row through the caller's `recordConsent` inside its
 * transaction, and reads compose `consent` from the newest registration row.
 */

import type {
  ActorType,
  AggregatorStatus,
  BecknContact,
  BecknLocation,
  ConsentRecord,
  RoleType,
} from '@aggregator-dpg/shared-primitives/aggregator';
import type { RecordConsentHook } from '../consent-ledger/hook.js';

export type { RecordConsentHook };

/**
 * A coordinator's own org-detail values that its org did not adopt (0028):
 * a key is present only where the value differs from the org's.
 */
export interface LegacyOrgDetails {
  url?: string | null;
  locations?: BecknLocation[];
  company?: string | null;
  gstNumber?: string | null;
}

export interface Aggregator {
  id: string;
  orgSlug: string;
  /** Always `'aggregator'` since 0029 (the column is gone; the API still returns it). */
  actorType: ActorType;
  name: string;
  /** The first domain of {@link serves}, or `null` when it serves every domain. */
  type: RoleType | null;
  /** The network domain ids the coordinator serves (`users.serves`, 0029); `[]` = every domain. */
  serves: RoleType[];
  /** Rendered from the org, else the coordinator's own value (0028). */
  url: string | null;
  /** FK → `contact.id` (migrations 0025/0026). PII-derived hash — never log it. */
  contactId: string;
  /** Beckn contact, composed from the linked `contact` row + `alternate_phone`. */
  contact: BecknContact;
  /** The contact's phone (derived from `contact`; kept for existing callers). */
  contactPhone: string;
  /** The contact's email, lowercased (derived from `contact`). */
  contactEmail: string;
  /** Rendered from the org, else the coordinator's own value (0028). */
  locations: BecknLocation[];
  /**
   * The newest registration consent from the ledger (`given_at` = its
   * `accepted_at`). `null` only when the ledger holds no registration row for
   * the coordinator (the 0029 verify gate V1 keeps that at zero).
   */
  consent: ConsentRecord | null;
  /**
   * Schema-driven registration fields with no column of their own. `{}` when
   * the deployment's registration schema declares no extra fields.
   */
  profile: Record<string, unknown>;
  /**
   * Which schema variant produced `profile`, e.g. `blue_dot/up-gzb/registration.v1`.
   * NULL on rows created before migration 0018.
   */
  profileRef: string | null;
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
   * The coordinator's org (`users.org_id`, migration 0028; was
   * `parent_org_id`). The single authority for the org→coordinator link
   * (spec A1). Every coordinator has one — formerly-flat coordinators belong
   * to the Default org — so it is `null` only for a store that predates 0028.
   */
  parentOrgId: string | null;
  /** Whether {@link parentOrgId} is the fixed Default org. */
  isDefaultOrg: boolean;
  /**
   * Email the coordinator was invited at (#701), when registered via an invite:
   * the invite's address (`users.invite_id`, 0029), else a pre-0029 address
   * kept in `profile.legacy_invite_email`. May differ from `contact.email`.
   * `null` for non-invite registrations.
   */
  inviteEmail: string | null;
  /** The invite the coordinator registered with (`registration_invites.jti`), or `null`. */
  inviteId: string | null;
  /**
   * Write-once rejection timestamp (#726). Set when a pending registration is
   * rejected (status → inactive); drives the re-registration cooling window.
   * `null` until/unless rejected.
   */
  rejectedAt: Date | null;
}

export interface CreateAggregatorInput {
  orgSlug: string;
  name: string;
  /** The domain served; `null` or `'both'` = every domain (stored as `serves = '{}'`). */
  type: RoleType | null;
  /** `contact.company` / `contact.gstNumber` are not stored (they belong to the org). */
  contact: BecknContact;
  /**
   * The registration's consent as accepted — a snapshot only the in-memory
   * store keeps (the Postgres store reads consent back from the ledger row
   * that {@link recordConsent} writes).
   */
  consent: ConsentRecord;
  /**
   * Writes the consent ledger row in the create transaction. Required, so no
   * caller can create a coordinator without a consent record (fail-closed).
   */
  recordConsent: RecordConsentHook;
  createdBy: string;
  updatedBy: string;
  /** The coordinator's org (`users.org_id`, required since 0028). */
  orgId: string;
  /**
   * The coordinator's own org-detail values. Set only for Default-org
   * registrations, whose org has no shared value (0028).
   */
  legacyOrgDetails?: LegacyOrgDetails | null;
  /** The invite consumed by this registration (#701; `registration_invites.jti`). */
  inviteId?: string | null;
  /**
   * Schema-driven registration fields with no column of their own. Defaults to
   * `{}` when omitted — the typed fields above stay authoritative for
   * everything they already carry.
   */
  profile?: Record<string, unknown>;
  /**
   * Which schema variant produced `profile`, e.g. `blue_dot/up-gzb/registration.v1`.
   * Defaults to null when omitted.
   */
  profileRef?: string | null;
}

/**
 * Patch shape for updates. `orgSlug` is intentionally absent — the DB trigger
 * `users_lock_signalstack_org_slug` rejects any attempt to mutate the slug.
 * Identity (`id`) and audit timestamps are server-managed too. Org details
 * (`url`, `locations`, company / GST) and the org link are not patchable here
 * (0028).
 */
export interface UpdateAggregatorPatch {
  name?: string;
  type?: RoleType | null;
  /**
   * The domains served (`[]` = every domain), set by the Phase 5 console;
   * wins over {@link type} when both are given.
   */
  serves?: RoleType[];
  /** `company` / `gstNumber` in it are ignored: they belong to the org. */
  contact?: BecknContact;
  status?: AggregatorStatus;
  /** Write-once rejection stamp (#726) — set only on the reject transition. */
  rejectedAt?: Date | null;
  updatedBy: string;
}

export interface ListAggregatorsFilter {
  limit?: number;
  offset?: number;
  status?: AggregatorStatus;
  /**
   * Only rows last updated strictly before this instant. Lets the stale-pending
   * cleanup filter by age in SQL, so the row cap counts stale rows (not fresh
   * ones masking them).
   */
  updatedBefore?: Date;
}

/** Keyset position in a {@link SearchCoordinatorsFilter} page (newest first). */
export interface CoordinatorCursor {
  createdAt: Date;
  id: string;
}

/**
 * A scoped coordinator search (Phase 5 console). `orgIds = null` means every
 * org (the network admin); an empty array means none (returns no rows).
 */
export interface SearchCoordinatorsFilter {
  orgIds: string[] | null;
  status?: AggregatorStatus;
  /** A network domain id the coordinator serves (`serves = '{}'` serves every domain). */
  serves?: string;
  cursor?: CoordinatorCursor;
  /** 1..100, default 20. */
  limit?: number;
}

/** One page of a coordinator search; `nextCursor` is null on the last page. */
export interface SearchCoordinatorsPage {
  rows: Aggregator[];
  nextCursor: CoordinatorCursor | null;
}

/** Coordinator counts of one org. */
export interface OrgCoordinatorCounts {
  total: number;
  pending: number;
}

/** Outcome of {@link AggregatorStoreBase.deleteIfPending}. */
export type DeleteIfPendingOutcome = 'deleted' | 'not_pending' | 'aborted';

export interface ListAggregatorsPage {
  rows: Aggregator[];
  total: number;
}

export type StoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'DUPLICATE_SLUG'; message: string }
  | { code: 'DUPLICATE_PHONE'; message: string }
  | { code: 'DUPLICATE_EMAIL'; message: string }
  /** Unique violation on a constraint this layer does not recognise (#718 review). */
  | { code: 'DUPLICATE'; message: string }
  | { code: 'CHECK_VIOLATION'; message: string }
  /** The `recordConsent` hook failed: nothing was created (0029). */
  | { code: 'CONSENT_WRITE_FAILED'; message: string }
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
   * Returns every coordinator whose `org_id` matches the given org id — the
   * spec §10 org-view query. `org_id` is the single authority for the
   * org→coordinator link (spec A1).
   *
   * @param orgId - `organisations.id`.
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
   * Atomic compare-and-set `pending`→`active`. Returns the updated row, or
   * `null` inside `ok` when the row was not `pending` (a concurrent approval
   * already committed). Lets the approval handler gate side effects (the
   * applicant email) on the single winner and avoids the read-then-write
   * TOCTOU of {@link updateStatus}.
   *
   * @param id - Aggregator UUID.
   * @param updatedBy - Audit actor.
   * @returns The updated row, or `null` when the row was not pending.
   */
  abstract approveFromPending(
    id: string,
    updatedBy: string,
  ): Promise<StoreResult<Aggregator | null>>;
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
  /**
   * Atomic compare-and-set `pending`→`inactive` with a write-once
   * `rejected_at`. Returns the updated row, or `null` inside `ok` when the row
   * was not `pending` (a concurrent decision already committed), so only the
   * winner sends the rejection email.
   *
   * @param id - Coordinator id.
   * @param updatedBy - The deciding actor (an admin user id, or `'admin'` for a signed link).
   * @returns The rejected row, or `null` when it was not pending.
   */
  abstract rejectFromPending(
    id: string,
    updatedBy: string,
  ): Promise<StoreResult<Aggregator | null>>;
  /**
   * Deletes a coordinator only while it is still `pending` and older than
   * `cutoff`, holding the row until `beforeCommit` (the Keycloak user delete)
   * has run: a concurrent approval waits, then finds the row gone; a failed
   * `beforeCommit` keeps the row for the next pass.
   *
   * @param id - Coordinator id.
   * @param cutoff - Only rows last updated before this instant.
   * @param beforeCommit - Runs with the row locked; `false` aborts the delete.
   * @returns `deleted`, `not_pending` (decided, fresh or gone), or `aborted`.
   */
  abstract deleteIfPending(
    id: string,
    cutoff: Date,
    beforeCommit: () => Promise<boolean>,
  ): Promise<StoreResult<DeleteIfPendingOutcome>>;
  /**
   * Scoped, keyset-paged coordinator search, newest first.
   *
   * @param filter - Scope (`orgIds`), filters and cursor.
   * @returns One page; an empty scope returns no rows.
   */
  abstract search(filter: SearchCoordinatorsFilter): Promise<StoreResult<SearchCoordinatorsPage>>;
  /**
   * Coordinator counts per org.
   *
   * @param orgIds - The orgs to count (empty → empty result).
   * @returns `orgId` → counts; an org without coordinators maps to zeros.
   */
  abstract countByOrg(orgIds: string[]): Promise<StoreResult<Record<string, OrgCoordinatorCounts>>>;
}
