/**
 * Aggregator-org store contract — the org system of record (spec §5.1).
 *
 * Belongs to `@aggregator-dpg/api`. The org is a thin DB row; the Keycloak
 * group is a future-authz mirror that this store does not read for scoping.
 * Status lives here so org approval uses an atomic compare-and-set single-use
 * guard (spec A3). Returns `OrgStoreResult<T>` on every boundary — never throws.
 */

import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';

export interface AggregatorOrg {
  id: string;
  slug: string;
  displayName: string;
  state: string | null;
  ownerEmail: string;
  ownerKcSub: string | null;
  kcGroupId: string | null;
  status: AggregatorStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrgInput {
  slug: string;
  displayName: string;
  state?: string | null;
  ownerEmail: string;
  ownerKcSub?: string | null;
  kcGroupId?: string | null;
}

export interface UpdateOrgPatch {
  displayName?: string;
  state?: string | null;
  ownerKcSub?: string | null;
  kcGroupId?: string | null;
  status?: AggregatorStatus;
}

export type OrgStoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'DUPLICATE_SLUG'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type OrgStoreResult<T> = { ok: true; value: T } | { ok: false; error: OrgStoreError };

/**
 * Abstract org persistence port. Concrete implementations must implement every
 * method (no partial stubs) and preserve the exact signatures.
 */
export abstract class AggregatorOrgStoreBase {
  abstract create(input: CreateOrgInput): Promise<OrgStoreResult<AggregatorOrg>>;
  abstract findById(id: string): Promise<OrgStoreResult<AggregatorOrg | null>>;
  abstract findBySlug(slug: string): Promise<OrgStoreResult<AggregatorOrg | null>>;
  abstract findByOwnerEmail(email: string): Promise<OrgStoreResult<AggregatorOrg | null>>;
  abstract listActive(): Promise<OrgStoreResult<AggregatorOrg[]>>;
  abstract update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<AggregatorOrg>>;
  /**
   * Atomic compare-and-set pending→active. Returns the updated row, or `null`
   * inside `ok` when the row was not `pending` (the single-use guard lost the
   * race / already decided). Never throws.
   *
   * @param id - The org id.
   * @returns The updated row, or `null` when the row was not pending.
   */
  abstract approve(id: string): Promise<OrgStoreResult<AggregatorOrg | null>>;
  /**
   * Atomic compare-and-set pending→inactive (== rejected). Same null-on-race
   * semantics as {@link approve}.
   *
   * @param id - The org id.
   * @returns The updated row, or `null` when the row was not pending.
   */
  abstract reject(id: string): Promise<OrgStoreResult<AggregatorOrg | null>>;
}
