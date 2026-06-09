/**
 * Registration links store contract.
 *
 * Persistence port for the `registration_links` table. Owns slug uniqueness,
 * status lifecycle (draft → live → retired), and qr_object_key updates.
 */

export type RegistrationLinkStatus = 'draft' | 'live' | 'retired';

/**
 * Per-link form shape:
 *   - `account_and_profile` (default): identity + full profile schema.
 *   - `account_only`: identity only (name + phone OR email + consent).
 *     Server forces submit_mode=account_only. Immutable after creation.
 */
export type RegistrationLinkSubmissionMode = 'account_only' | 'account_and_profile';

export interface RegistrationLink {
  id: string;
  aggregatorId: string;
  slug: string;
  domain: string;
  context: Record<string, unknown>;
  /** See {@link RegistrationLinkSubmissionMode}. */
  submissionMode: RegistrationLinkSubmissionMode;
  qrObjectKey: string | null;
  status: RegistrationLinkStatus;
  expiresAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRegistrationLinkInput {
  aggregatorId: string;
  slug: string;
  domain: string;
  context: Record<string, unknown>;
  status?: RegistrationLinkStatus;
  /** Defaults to `'account_and_profile'` when omitted. */
  submissionMode?: RegistrationLinkSubmissionMode;
  expiresAt?: Date | null;
  createdBy: string;
}

/**
 * Partial patch shape accepted by {@link RegistrationLinksStoreBase.updateDraft}.
 * Only fields that should be mutated on a draft are present. `null` on
 * `expiresAt` clears the expiry; omitting the key leaves the column untouched.
 */
export interface UpdateDraftInput {
  slug?: string;
  context?: Record<string, unknown>;
  expiresAt?: Date | null;
}

export type StoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'SLUG_COLLISION'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: StoreError };

export interface ListRegistrationLinksOptions {
  status?: RegistrationLinkStatus;
  limit: number;
  offset: number;
}

export interface ListRegistrationLinksResult {
  rows: RegistrationLink[];
  total: number;
}

export abstract class RegistrationLinksStoreBase {
  /**
   * Create a new registration link. Returns SLUG_COLLISION on slug uniqueness
   * violation so the caller can retry with a fresh suffix.
   */
  abstract create(input: CreateRegistrationLinkInput): Promise<StoreResult<RegistrationLink>>;
  /**
   * Find a link by id, scoped to the calling aggregator. Cross-aggregator
   * access is enforced at the store boundary so route-layer mistakes can't
   * leak rows.
   */
  abstract findById(
    id: string,
    aggregatorId: string,
  ): Promise<StoreResult<RegistrationLink | null>>;
  /**
   * Find a link by its public slug. Used by the public resolve and submit
   * endpoints — no aggregator scoping; the slug is the access token.
   *
   * @deprecated Slug is now unique per-aggregator (migration 0008). Use
   *   {@link findByOrgAndSlug} for the new `/<org_slug>/<slug>` public URL.
   */
  abstract findBySlug(slug: string): Promise<StoreResult<RegistrationLink | null>>;

  /**
   * Public-URL lookup keyed by (aggregator's `org_slug`, registration link
   * slug). JOINs `aggregators` on `org_slug` so the route layer doesn't need
   * a separate aggregator-resolve step.
   */
  abstract findByOrgAndSlug(
    orgSlug: string,
    slug: string,
  ): Promise<StoreResult<RegistrationLink | null>>;
  /** Set the qr_object_key after the QR PNG has been uploaded to S3. */
  abstract updateQrKey(
    id: string,
    aggregatorId: string,
    qrObjectKey: string,
  ): Promise<StoreResult<RegistrationLink>>;
  /**
   * Patch the editable fields on a draft row (`slug`, `context`, `expires_at`).
   * Live + retired rows reject with `NOT_FOUND` so the caller can surface a
   * "edits are only allowed on drafts" error without leaking the row's
   * existence. Slug uniqueness violations return `SLUG_COLLISION`, mirroring
   * {@link create}, so the caller can retry with a fresh suffix.
   */
  abstract updateDraft(
    id: string,
    aggregatorId: string,
    patch: UpdateDraftInput,
  ): Promise<StoreResult<RegistrationLink>>;
  /**
   * Paginated list scoped to one aggregator. Most-recent first. Optional
   * status filter narrows to draft/live/retired.
   */
  abstract list(
    aggregatorId: string,
    options: ListRegistrationLinksOptions,
  ): Promise<StoreResult<ListRegistrationLinksResult>>;
  /**
   * Flip a link's status. Idempotent — calling with the current status
   * returns the row unchanged.
   */
  abstract updateStatus(
    id: string,
    aggregatorId: string,
    nextStatus: RegistrationLinkStatus,
  ): Promise<StoreResult<RegistrationLink>>;
}
