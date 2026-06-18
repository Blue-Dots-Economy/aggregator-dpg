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
  | 'ss_org'
  | 'graduated'
  | 'welcome'
  | 'rejection';

export type ProvisionStatus = 'done' | 'failed' | 'pending';

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

  provisionState: Partial<Record<ProvisionKey, ProvisionStatus>>;

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
  reconcilerClaimedAt?: Date | null;
  /** Replaces the entire provisionState map. Pass `{}` to clear all steps. */
  provisionState?: Partial<Record<ProvisionKey, ProvisionStatus>>;
}

export interface TransitionMeta {
  actor: RegistrationActor;
  reason?: string;
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
   * @param id - Registration UUID.
   * @param key - Provision step key.
   * @param status - New status for the step.
   */
  abstract markProjection(
    id: string,
    key: ProvisionKey,
    status: ProvisionStatus,
  ): Promise<StoreResult<void>>;

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
