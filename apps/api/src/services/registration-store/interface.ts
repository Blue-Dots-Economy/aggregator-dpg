/**
 * Registration store contract.
 *
 * Persistence port for the `registrations` and `registration_transitions`
 * tables. Models the aggregator registration flow as a forward-only state
 * machine where `transition()` is the only way to change state, using
 * compare-and-set semantics (version field) to prevent concurrent races.
 *
 * Concrete adapters: Postgres for production, in-memory for tests.
 */

export type RegistrationState =
  | 'submitted'
  | 'verified'
  | 'approved'
  | 'rejected'
  | 'active'
  | 'abandoned';

export type RegistrationActor = 'applicant' | 'admin' | 'reconciler' | 'system';

export type ProvisionKey =
  | 'verification'
  | 'admin_notify'
  | 'kc_user'
  | 'kc_disabled'
  | 'ss_org'
  | 'graduated'
  | 'welcome'
  | 'rejection'
  | 'purged';

export type ProvisionStatus = 'done' | 'failed' | 'pending' | 'dead';

/** Per-step attempt record stored in `provision_attempts`. */
export interface ProvisionAttemptEntry {
  attempts: number;
  /** ISO-8601 timestamp of the most recent attempt. */
  last_attempt_at: string;
}

export interface Registration {
  id: string;
  idempotencyKey: string;
  state: RegistrationState;

  contactEmail: string;
  contactPhone: string;

  orgName: string;
  orgType: string;
  orgUrl: string | null;
  orgLocations: Record<string, unknown>[];
  profileDraft: Record<string, unknown>;
  consent: Record<string, unknown>;

  idpUserId: string | null;
  signalstackOrgId: string | null;
  /** FK to aggregators.id — set when the registration graduates to active. */
  aggregatorId: string | null;

  verificationSentAt: Date | null;
  verifiedAt: Date | null;
  adminNotifiedAt: Date | null;
  approvalLinkIssuedAt: Date | null;
  welcomeSentAt: Date | null;
  rejectionSentAt: Date | null;

  provisionState: Partial<Record<ProvisionKey, ProvisionStatus>>;
  /** Per-step attempt counters for backoff and dead-letter tracking. */
  provisionAttempts: Partial<Record<ProvisionKey, ProvisionAttemptEntry>>;

  /** Optimistic-lock counter. Incremented on every transition. */
  version: number;
  /** Set while the reconciler holds this row to prevent concurrent repair. */
  reconcilerClaimedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRegistrationInput {
  idempotencyKey: string;
  contactEmail: string;
  contactPhone: string;
  orgName: string;
  orgType: string;
  orgUrl?: string | null;
  orgLocations?: Record<string, unknown>[];
  profileDraft?: Record<string, unknown>;
  consent: Record<string, unknown>;
}

/** Fields that may be patched alongside a state transition. */
export interface TransitionPatch {
  idpUserId?: string;
  signalstackOrgId?: string;
  aggregatorId?: string;
  /** Pass `null` to reset (e.g. when re-opening an abandoned registration). */
  verificationSentAt?: Date | null;
  /** Pass `null` to reset. */
  verifiedAt?: Date | null;
  /** Pass `null` to reset. */
  adminNotifiedAt?: Date | null;
  /** Pass `null` to reset. */
  approvalLinkIssuedAt?: Date | null;
  /** Pass `null` to reset. */
  welcomeSentAt?: Date | null;
  /** Pass `null` to reset. */
  rejectionSentAt?: Date | null;
  reconcilerClaimedAt?: Date | null;
  /** Replaces the entire provisionState map. Pass `{}` to clear all steps. */
  provisionState?: Partial<Record<ProvisionKey, ProvisionStatus>>;
}

export interface TransitionMeta {
  actor: RegistrationActor;
  reason?: string;
}

/** Options for `markProjection`. */
export interface MarkProjectionOpts {
  /** When true, increments the attempt counter and stamps `last_attempt_at`. */
  bumpAttempt?: boolean;
}

export type RegistrationStoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'DUPLICATE_IDEMPOTENCY_KEY'; message: string }
  | { code: 'DUPLICATE_EMAIL'; message: string }
  | { code: 'DUPLICATE_PHONE'; message: string }
  | { code: 'STALE_TRANSITION'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: RegistrationStoreError };

/**
 * Abstract registration persistence port.
 *
 * All writes go through `transition()` which enforces compare-and-set
 * semantics. No method throws — all failures surface as typed StoreResult.
 */
export abstract class RegistrationStoreBase {
  /**
   * Inserts a new registration row in `submitted` state.
   *
   * @param input - Required fields for a new application.
   * @returns The created registration, or DUPLICATE_* on conflict.
   */
  abstract create(input: CreateRegistrationInput): Promise<StoreResult<Registration>>;

  /**
   * Looks up a registration by its idempotency key.
   *
   * @param key - Deduplication key supplied by the caller.
   * @returns The matching row or null; DB_UNAVAILABLE on error.
   */
  abstract findByIdempotencyKey(key: string): Promise<StoreResult<Registration | null>>;

  /**
   * Finds a non-terminal registration by email or phone.
   *
   * @param field - Which contact field to match on.
   * @param value - The normalised contact value.
   * @returns The matching row or null; DB_UNAVAILABLE on error.
   */
  abstract findByContact(
    field: 'email' | 'phone',
    value: string,
  ): Promise<StoreResult<Registration | null>>;

  /**
   * Loads a registration by primary key.
   *
   * @param id - Registration UUID.
   * @returns The row or null; DB_UNAVAILABLE on error.
   */
  abstract findById(id: string): Promise<StoreResult<Registration | null>>;

  /**
   * Atomically transitions state using compare-and-set on `version`.
   *
   * Updates state, bumps `version`, applies `patch`, and records a
   * transition audit row — all in a single transaction. Returns
   * STALE_TRANSITION when the version no longer matches (someone else
   * already changed state), which the caller must treat as a no-op.
   *
   * @param id - Registration UUID.
   * @param fromState - Expected current state (guard).
   * @param toState - Desired next state.
   * @param patch - Optional field updates applied alongside the transition.
   * @param version - Expected version; any mismatch → STALE_TRANSITION.
   * @param meta - Audit info: which actor triggered the transition.
   */
  abstract transition(
    id: string,
    fromState: RegistrationState,
    toState: RegistrationState,
    patch: TransitionPatch,
    version: number,
    meta: TransitionMeta,
  ): Promise<StoreResult<Registration>>;

  /**
   * Returns all registrations in non-terminal states.
   *
   * Used by the reconciler to find rows that still need provisioning work.
   *
   * @returns List of non-terminal registrations; DB_UNAVAILABLE on error.
   */
  abstract listNonTerminal(): Promise<StoreResult<Registration[]>>;

  /**
   * Returns non-terminal registrations that have at least one `failed`
   * provision_state entry — i.e. rows the reconciler should retry.
   *
   * @returns List of flagged registrations; DB_UNAVAILABLE on error.
   */
  abstract listFlaggedForReconcile(): Promise<StoreResult<Registration[]>>;

  /**
   * Updates a single key inside `provision_state` without touching version.
   *
   * Never downgrades a `done` step to any other status. When `opts.bumpAttempt`
   * is true, increments the attempt counter in `provision_attempts` and stamps
   * `last_attempt_at`.
   *
   * @param id - Registration UUID.
   * @param key - Provision step key.
   * @param status - New status for the step.
   * @param opts - Optional behaviour flags.
   */
  abstract markProjection(
    id: string,
    key: ProvisionKey,
    status: ProvisionStatus,
    opts?: MarkProjectionOpts,
  ): Promise<StoreResult<void>>;

  /**
   * Persists the Keycloak user id immediately after the user is created.
   *
   * Called before `enableUser` / `setAttributes` so that a crash between
   * creation and marking `kc_user='done'` does not orphan the KC user.
   *
   * @param id - Registration UUID.
   * @param userId - Keycloak user UUID.
   */
  abstract setIdpUserId(id: string, userId: string): Promise<StoreResult<void>>;

  /**
   * Atomically claims a row for reconciliation if the current claim is absent or stale.
   *
   * Returns `true` when the claim was won (caller should proceed), `false` when
   * another caller holds a live claim (caller should skip).
   *
   * @param id - Registration UUID.
   * @param claimedAt - Timestamp to write as the new claim stamp.
   * @param expiry - Claims older than this are considered stale and overridable.
   */
  abstract claimRow(id: string, claimedAt: Date, expiry: Date): Promise<StoreResult<boolean>>;

  /**
   * Releases a reconciler claim using compare-and-clear semantics.
   *
   * Only clears `reconciler_claimed_at` when it still holds the exact
   * timestamp written by this caller's `claimRow` call. A no-op if the
   * claim was already cleared or replaced.
   *
   * @param id - Registration UUID.
   * @param claimedAt - The exact timestamp this caller wrote when claiming.
   */
  abstract releaseClaim(id: string, claimedAt: Date): Promise<StoreResult<void>>;

  /**
   * Redacts PII fields to sentinels and marks the `purged` provision key.
   *
   * Writes `contact_email = "purged-<id>@redacted.invalid"`,
   * `contact_phone = ""`, `profile_draft = {}`, and sets
   * `provision_state.purged = "done"` in a single atomic UPDATE.
   * All three contact fields are NOT NULL — sentinels satisfy the constraint.
   *
   * @param id - Registration UUID.
   */
  abstract purgePii(id: string): Promise<StoreResult<void>>;

  /**
   * Finds the most recent abandoned registration matching a contact field.
   *
   * Unlike `findByContact`, this method searches only among `abandoned` rows.
   * Used by the admin re-open endpoint to locate a registration by email/phone.
   *
   * @param field - Which contact field to match on.
   * @param value - The normalised contact value.
   * @returns The most recently updated abandoned row, or null; DB_UNAVAILABLE on error.
   */
  abstract findAbandonedByContact(
    field: 'email' | 'phone',
    value: string,
  ): Promise<StoreResult<Registration | null>>;

  /**
   * Returns the FSM state the registration was in immediately before abandonment.
   *
   * Queries `registration_transitions` for the most recent row where
   * `to_state = 'abandoned'` and returns its `from_state`. Returns null when no
   * such transition exists (e.g. the row was seeded directly in `abandoned`).
   *
   * @param id - Registration UUID.
   * @returns The pre-abandonment state, or null; DB_UNAVAILABLE on error.
   */
  abstract getPreAbandonmentState(id: string): Promise<StoreResult<RegistrationState | null>>;
}
