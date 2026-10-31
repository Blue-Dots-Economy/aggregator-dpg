/**
 * Organisation store contract; the system of record for orgs.
 *
 * Belongs to `@aggregator-dpg/api`. An org is a row of `organisations`; the
 * Keycloak group is a mirror this store does not read. Approval is an atomic
 * compare-and-set on status. Every method returns `OrgStoreResult<T>` and
 * never throws.
 *
 * Every method except {@link OrganisationStoreBase.findRoot} sees `aggregator`
 * orgs only, never the network-facilitator root. Owner lookups also skip the
 * Default org, which the network admin owns.
 */

import type { AggregatorStatus, BecknLocation } from '@aggregator-dpg/shared-primitives/aggregator';
import type { RecordConsentHook } from '../consent-ledger/hook.js';

/** Slug of the fixed Default org, which holds coordinators with no other org. */
export const DEFAULT_ORG_SLUG = 'default';

export interface Organisation {
  id: string;
  slug: string;
  displayName: string;
  state: string | null;
  /** FK to `contact.id`, the owner's contact. PII-derived hash: never log it. */
  contactId: string;
  /** The owner's admin account (`users.id`). */
  ownerUserId: string;
  /** Owner email, lowercased, from the linked contact. */
  ownerEmail: string;
  /** Owner phone (canonical), from the linked contact. */
  ownerPhone: string | null;
  /**
   * Owner name, from the linked contact. `null` for older owners until
   * `scripts/backfill-owner-contact-names.ts` has run.
   */
  ownerName: string | null;
  ownerKcSub: string | null;
  kcGroupId: string | null;
  /**
   * Registration fields that have no column of their own. The typed columns
   * above take precedence.
   */
  profile: Record<string, unknown>;
  /** Schema variant that produced `profile`, e.g. `blue_dot/org-registration.v1`; may be null. */
  profileRef: string | null;
  status: AggregatorStatus;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Who made the last write: an admin user id (console), `'admin'` (emailed
   * link) or `'self'`; `null` when unknown.
   */
  updatedBy: string | null;
  /** Write-once rejection time; drives the cooling window. */
  rejectedAt: Date | null;
  /** Whether this is the fixed Default org (slug {@link DEFAULT_ORG_SLUG}). */
  isDefault: boolean;
  /** Org details, shown for every coordinator of the org. */
  locations: BecknLocation[];
  legalName: string | null;
  /** The owner's description of the org. Informational only. */
  description: string | null;
}

export interface CreateOrgInput {
  slug: string;
  displayName: string;
  state?: string | null;
  ownerEmail: string;
  ownerPhone?: string | null;
  /** Owner's name as submitted; stored on the contact when it has none yet. */
  ownerName?: string | null;
  ownerKcSub?: string | null;
  kcGroupId?: string | null;
  profile?: Record<string, unknown>;
  profileRef?: string | null;
  /** Org locations from the registration form's address. */
  locations?: BecknLocation[];
  /**
   * Writes the org's consent ledger row inside the create transaction.
   * Required, so no org is created without a consent record.
   */
  recordConsent: RecordConsentHook;
}

export interface UpdateOrgPatch {
  displayName?: string;
  state?: string | null;
  ownerKcSub?: string | null;
  kcGroupId?: string | null;
  status?: AggregatorStatus;
  /** Write-once rejection time; set to `null` to revive after cooling. */
  rejectedAt?: Date | null;
  /** Org details, edited from the console. */
  locations?: BecknLocation[];
  legalName?: string | null;
  description?: string | null;
  /**
   * Keys to merge into `profile`: each value replaces the stored one, `null`
   * removes the key, keys not named are kept.
   */
  profileMerge?: Record<string, unknown>;
  /** Who made this write: an admin user id, `'self'` or `'admin'`. */
  updatedBy?: string;
}

/** Keyset position in an org search page (by name, then id). */
export interface OrgCursor {
  name: string;
  id: string;
}

/**
 * A scoped org search. `orgIds = null` means every aggregator org (the
 * network admin); an empty array means none.
 */
export interface SearchOrgsFilter {
  orgIds: string[] | null;
  status?: AggregatorStatus;
  /** Case-insensitive name prefix. */
  namePrefix?: string;
  cursor?: OrgCursor;
  /** 1..100, default 20. */
  limit?: number;
}

/** One page of an org search; `nextCursor` is null on the last page. */
export interface SearchOrgsPage {
  rows: Organisation[];
  nextCursor: OrgCursor | null;
}

/** Outcome of {@link OrganisationStoreBase.deleteIfPending}. */
export type OrgDeleteIfPendingOutcome = 'deleted' | 'not_pending' | 'aborted';

export type OrgStoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'DUPLICATE_SLUG'; message: string }
  | { code: 'DUPLICATE_NAME'; message: string }
  /** The owner's email already belongs to another person. */
  | { code: 'DUPLICATE_EMAIL'; message: string }
  /** The owner's phone already belongs to another person. */
  | { code: 'DUPLICATE_PHONE'; message: string }
  /** The `recordConsent` hook failed; nothing was created. */
  | { code: 'CONSENT_WRITE_FAILED'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type OrgStoreResult<T> = { ok: true; value: T } | { ok: false; error: OrgStoreError };

/**
 * Abstract org persistence port. Concrete implementations must implement every
 * method (no partial stubs) and preserve the exact signatures.
 */
export abstract class OrganisationStoreBase {
  abstract create(input: CreateOrgInput): Promise<OrgStoreResult<Organisation>>;
  abstract findById(id: string): Promise<OrgStoreResult<Organisation | null>>;
  abstract findBySlug(slug: string): Promise<OrgStoreResult<Organisation | null>>;
  abstract findByOwnerEmail(email: string): Promise<OrgStoreResult<Organisation | null>>;
  /**
   * Finds an org whose owner holds this phone.
   *
   * Used by the org-create check that keeps one phone per person; the phone
   * is the OTP login key.
   *
   * @param phone - Canonical (`normalisePhone`) phone.
   * @returns The first matching org, or `null`.
   */
  abstract findByOwnerPhone(phone: string): Promise<OrgStoreResult<Organisation | null>>;
  /**
   * Lists active aggregator orgs (the registration dropdown), Default
   * included, sorted by name (case-insensitive).
   *
   * @returns Active aggregator orgs, possibly empty.
   */
  abstract listActive(): Promise<OrgStoreResult<Organisation[]>>;
  /**
   * Finds the fixed Default org.
   *
   * @returns The Default org, or `null` when it is not seeded.
   */
  abstract findDefault(): Promise<OrgStoreResult<Organisation | null>>;
  /**
   * Finds the network-facilitator root; the only method that returns it.
   *
   * @returns The root org, or `null` when absent.
   */
  abstract findRoot(): Promise<OrgStoreResult<Organisation | null>>;
  /**
   * Lists `pending` orgs, optionally only those last updated before `updatedBefore`.
   *
   * Used by the stale-pending cleanup. The age filter keeps fresh rows from
   * filling the cleanup's row cap.
   *
   * @param updatedBefore - When set, only rows with `updated_at < updatedBefore`.
   * @returns Matching `pending` rows (may be empty).
   */
  abstract listPending(updatedBefore?: Date): Promise<OrgStoreResult<Organisation[]>>;
  abstract update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<Organisation>>;
  /**
   * Hard-deletes an org row by id.
   *
   * Used by the stale-pending cleanup after the Keycloak group and owner are removed.
   *
   * @param id - The org id to delete.
   * @returns `ok` with `void`; `NOT_FOUND` is treated as success (idempotent).
   */
  abstract deleteById(id: string): Promise<OrgStoreResult<void>>;
  /**
   * Whether the org's owner is still needed elsewhere.
   *
   * True when the owner owns another org or also has a coordinator account.
   * A shared owner keeps their IdP user when this org is deleted.
   *
   * @param id - Org UUID.
   * @returns `true` inside `ok` when the owner is shared.
   */
  abstract ownerIsShared(id: string): Promise<OrgStoreResult<boolean>>;
  /**
   * Moves the org from pending to active with an atomic compare-and-set.
   *
   * @param id - The org id.
   * @param updatedBy - The decider, written in the same statement (`'admin'`
   *   for an emailed link, else the admin's user id).
   * @returns The updated row, or `null` when the row was not pending (another decision won).
   */
  abstract approve(id: string, updatedBy: string): Promise<OrgStoreResult<Organisation | null>>;
  /**
   * Moves the org from pending to inactive (rejected) with an atomic compare-and-set.
   *
   * @param id - The org id.
   * @param updatedBy - The decider (see {@link approve}).
   * @returns The updated row, or `null` when the row was not pending.
   */
  abstract reject(id: string, updatedBy: string): Promise<OrgStoreResult<Organisation | null>>;
  /**
   * Lists the aggregator orgs (Default included) an admin account owns.
   *
   * @param ownerUserId - The admin `users.id`.
   * @returns The owned orgs, by name; empty when none.
   */
  abstract listOwnedBy(ownerUserId: string): Promise<OrgStoreResult<Organisation[]>>;
  /**
   * Searches aggregator orgs by name, scoped and keyset-paged.
   *
   * @param filter - Scope (`orgIds`), filters and cursor.
   * @returns One page; an empty scope returns no rows.
   */
  abstract search(filter: SearchOrgsFilter): Promise<OrgStoreResult<SearchOrgsPage>>;
  /**
   * Deletes an org only while it is still `pending` and older than `cutoff`.
   *
   * The row stays locked until `beforeCommit` (the Keycloak clean-up) has run,
   * so a concurrent approval waits and then finds the row gone.
   *
   * @param id - Org id.
   * @param cutoff - Only rows last updated before this instant.
   * @param beforeCommit - Runs with the row locked; `false` aborts the delete.
   * @returns `deleted`, `not_pending` (decided, fresh or gone), or `aborted`.
   */
  abstract deleteIfPending(
    id: string,
    cutoff: Date,
    beforeCommit: () => Promise<boolean>,
  ): Promise<OrgStoreResult<OrgDeleteIfPendingOutcome>>;
}
