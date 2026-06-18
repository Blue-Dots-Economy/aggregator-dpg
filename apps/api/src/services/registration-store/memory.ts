/**
 * In-memory registration store.
 *
 * Process-local Maps. Suitable for unit tests. Mirrors Postgres adapter
 * semantics: idempotency-key dedup, partial uniqueness on non-terminal
 * email/phone, compare-and-set transition, provision_state patching,
 * no-downgrade markProjection, compare-and-clear claim release.
 */

import { randomUUID } from 'node:crypto';
import {
  RegistrationStoreBase,
  type CreateRegistrationInput,
  type MarkProjectionOpts,
  type ProvisionKey,
  type ProvisionStatus,
  type Registration,
  type RegistrationState,
  type StoreResult,
  type TransitionMeta,
  type TransitionPatch,
} from './interface.js';

// 'active' excluded: active registrations block re-registration but the reconciler
// may still need to retry failed projections (KC user, ss org, welcome email).
const TERMINAL_STATES: RegistrationState[] = ['rejected', 'abandoned'];

interface TransitionRecord {
  registrationId: string;
  fromState: RegistrationState;
  toState: RegistrationState;
  at: Date;
}

export class InMemoryRegistrationStore extends RegistrationStoreBase {
  protected readonly byId = new Map<string, Registration>();
  protected readonly byIdempotencyKey = new Map<string, string>();
  protected readonly transitions: TransitionRecord[] = [];

  async create(input: CreateRegistrationInput): Promise<StoreResult<Registration>> {
    if (this.byIdempotencyKey.has(input.idempotencyKey)) {
      return err('DUPLICATE_IDEMPOTENCY_KEY', `key: ${input.idempotencyKey}`);
    }

    // Partial uniqueness: only enforce email/phone uniqueness for non-terminal rows.
    for (const row of this.byId.values()) {
      if (!TERMINAL_STATES.includes(row.state)) {
        if (row.contactEmail === input.contactEmail.toLowerCase()) {
          return err('DUPLICATE_EMAIL', input.contactEmail);
        }
        if (row.contactPhone === input.contactPhone) {
          return err('DUPLICATE_PHONE', input.contactPhone);
        }
      }
    }

    const now = new Date();
    const row: Registration = {
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      state: 'submitted',
      contactEmail: input.contactEmail.toLowerCase(),
      contactPhone: input.contactPhone,
      orgName: input.orgName,
      orgType: input.orgType,
      orgUrl: input.orgUrl ?? null,
      orgLocations: input.orgLocations ?? [],
      profileDraft: input.profileDraft ?? {},
      consent: input.consent,
      idpUserId: null,
      signalstackOrgId: null,
      aggregatorId: null,
      verificationSentAt: null,
      verifiedAt: null,
      adminNotifiedAt: null,
      approvalLinkIssuedAt: null,
      welcomeSentAt: null,
      rejectionSentAt: null,
      provisionState: {},
      provisionAttempts: {},
      version: 0,
      reconcilerClaimedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(row.id, row);
    this.byIdempotencyKey.set(row.idempotencyKey, row.id);
    return { ok: true, value: row };
  }

  async findByIdempotencyKey(key: string): Promise<StoreResult<Registration | null>> {
    const id = this.byIdempotencyKey.get(key);
    return { ok: true, value: id ? (this.byId.get(id) ?? null) : null };
  }

  async findByContact(
    field: 'email' | 'phone',
    value: string,
  ): Promise<StoreResult<Registration | null>> {
    const normalised = field === 'email' ? value.toLowerCase() : value;
    for (const row of this.byId.values()) {
      if (TERMINAL_STATES.includes(row.state)) continue;
      if (field === 'email' && row.contactEmail === normalised) return { ok: true, value: row };
      if (field === 'phone' && row.contactPhone === normalised) return { ok: true, value: row };
    }
    return { ok: true, value: null };
  }

  async findById(id: string): Promise<StoreResult<Registration | null>> {
    return { ok: true, value: this.byId.get(id) ?? null };
  }

  async transition(
    id: string,
    fromState: RegistrationState,
    toState: RegistrationState,
    patch: TransitionPatch,
    version: number,
    _meta: TransitionMeta,
  ): Promise<StoreResult<Registration>> {
    const existing = this.byId.get(id);
    if (!existing) return err('NOT_FOUND', id);

    // Compare-and-set: both state AND version must match.
    if (existing.state !== fromState || existing.version !== version) {
      return err('STALE_TRANSITION', `expected state=${fromState} version=${version}`);
    }

    const now = new Date();
    const next: Registration = {
      ...existing,
      state: toState,
      version: version + 1,
      idpUserId: patch.idpUserId ?? existing.idpUserId,
      signalstackOrgId: patch.signalstackOrgId ?? existing.signalstackOrgId,
      aggregatorId: patch.aggregatorId ?? existing.aggregatorId,
      // Use 'in patch' so explicit null resets the field.
      verificationSentAt:
        'verificationSentAt' in patch
          ? (patch.verificationSentAt ?? null)
          : existing.verificationSentAt,
      verifiedAt: 'verifiedAt' in patch ? (patch.verifiedAt ?? null) : existing.verifiedAt,
      adminNotifiedAt:
        'adminNotifiedAt' in patch ? (patch.adminNotifiedAt ?? null) : existing.adminNotifiedAt,
      approvalLinkIssuedAt:
        'approvalLinkIssuedAt' in patch
          ? (patch.approvalLinkIssuedAt ?? null)
          : existing.approvalLinkIssuedAt,
      welcomeSentAt:
        'welcomeSentAt' in patch ? (patch.welcomeSentAt ?? null) : existing.welcomeSentAt,
      rejectionSentAt:
        'rejectionSentAt' in patch ? (patch.rejectionSentAt ?? null) : existing.rejectionSentAt,
      reconcilerClaimedAt:
        'reconcilerClaimedAt' in patch
          ? (patch.reconcilerClaimedAt ?? null)
          : existing.reconcilerClaimedAt,
      provisionState:
        'provisionState' in patch ? (patch.provisionState ?? {}) : existing.provisionState,
      updatedAt: now,
    };
    this.byId.set(id, next);
    this.transitions.push({ registrationId: id, fromState, toState, at: now });
    return { ok: true, value: next };
  }

  async listNonTerminal(): Promise<StoreResult<Registration[]>> {
    const rows = [...this.byId.values()].filter((r) => !TERMINAL_STATES.includes(r.state));
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return { ok: true, value: rows };
  }

  async listFlaggedForReconcile(): Promise<StoreResult<Registration[]>> {
    const rows = [...this.byId.values()].filter((r) => {
      if (TERMINAL_STATES.includes(r.state)) return false;
      return Object.values(r.provisionState).includes('failed');
    });
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return { ok: true, value: rows };
  }

  async markProjection(
    id: string,
    key: ProvisionKey,
    status: ProvisionStatus,
    opts?: MarkProjectionOpts,
  ): Promise<StoreResult<void>> {
    const row = this.byId.get(id);
    if (!row) return err('NOT_FOUND', id);

    // No-downgrade: never overwrite a 'done' step with a non-done status.
    const currentStatus = row.provisionState[key];
    const nextStatus = currentStatus === 'done' && status !== 'done' ? currentStatus : status;

    let nextAttempts = row.provisionAttempts;
    if (opts?.bumpAttempt) {
      const current = row.provisionAttempts[key] ?? { attempts: 0, last_attempt_at: '' };
      nextAttempts = {
        ...row.provisionAttempts,
        [key]: {
          attempts: current.attempts + 1,
          last_attempt_at: new Date().toISOString(),
        },
      };
    }

    this.byId.set(id, {
      ...row,
      provisionState: { ...row.provisionState, [key]: nextStatus },
      provisionAttempts: nextAttempts,
      ...(opts?.welcomeSentAt !== undefined ? { welcomeSentAt: opts.welcomeSentAt } : {}),
      ...(opts?.rejectionSentAt !== undefined ? { rejectionSentAt: opts.rejectionSentAt } : {}),
      updatedAt: new Date(),
    });
    return { ok: true, value: undefined };
  }

  async setIdpUserId(id: string, userId: string): Promise<StoreResult<void>> {
    const row = this.byId.get(id);
    if (!row) return err('NOT_FOUND', id);
    this.byId.set(id, { ...row, idpUserId: userId, updatedAt: new Date() });
    return { ok: true, value: undefined };
  }

  async claimRow(id: string, claimedAt: Date, expiry: Date): Promise<StoreResult<boolean>> {
    const row = this.byId.get(id);
    if (!row) return { ok: true, value: false };

    const current = row.reconcilerClaimedAt;
    // Win if: no existing claim OR the existing claim is stale (before expiry).
    if (current !== null && current >= expiry) {
      return { ok: true, value: false };
    }

    this.byId.set(id, { ...row, reconcilerClaimedAt: claimedAt, updatedAt: new Date() });
    return { ok: true, value: true };
  }

  async releaseClaim(id: string, claimedAt: Date): Promise<StoreResult<void>> {
    const row = this.byId.get(id);
    if (!row) return { ok: true, value: undefined };
    // Compare-and-clear: only clear if we own the exact claim.
    if (row.reconcilerClaimedAt?.getTime() === claimedAt.getTime()) {
      this.byId.set(id, { ...row, reconcilerClaimedAt: null, updatedAt: new Date() });
    }
    return { ok: true, value: undefined };
  }

  async purgePii(id: string): Promise<StoreResult<void>> {
    const row = this.byId.get(id);
    if (!row) return err('NOT_FOUND', id);
    this.byId.set(id, {
      ...row,
      contactEmail: `purged-${id}@redacted.invalid`,
      contactPhone: '',
      profileDraft: {},
      provisionState: { ...row.provisionState, purged: 'done' },
      updatedAt: new Date(),
    });
    return { ok: true, value: undefined };
  }

  async findAbandonedByContact(
    field: 'email' | 'phone',
    value: string,
  ): Promise<StoreResult<Registration | null>> {
    const normalised = field === 'email' ? value.toLowerCase() : value;
    let latest: Registration | null = null;
    for (const row of this.byId.values()) {
      if (row.state !== 'abandoned') continue;
      const match =
        field === 'email' ? row.contactEmail === normalised : row.contactPhone === normalised;
      if (!match) continue;
      if (!latest || row.updatedAt > latest.updatedAt) latest = row;
    }
    return { ok: true, value: latest };
  }

  async getPreAbandonmentState(id: string): Promise<StoreResult<RegistrationState | null>> {
    // Walk the transitions array in reverse insertion order to find the most
    // recent transition that targeted 'abandoned'. Reverse order acts as a
    // tiebreaker when multiple transitions share the same timestamp (common in
    // tests where all transitions fire within the same millisecond).
    for (let i = this.transitions.length - 1; i >= 0; i--) {
      const t = this.transitions[i]!;
      if (t.registrationId === id && t.toState === 'abandoned') {
        return { ok: true, value: t.fromState };
      }
    }
    return { ok: true, value: null };
  }

  /** Reset all state between tests. */
  reset(): void {
    this.byId.clear();
    this.byIdempotencyKey.clear();
    this.transitions.length = 0;
  }
}

function err<T>(
  code:
    | 'NOT_FOUND'
    | 'DUPLICATE_IDEMPOTENCY_KEY'
    | 'DUPLICATE_EMAIL'
    | 'DUPLICATE_PHONE'
    | 'STALE_TRANSITION'
    | 'DB_UNAVAILABLE',
  message: string,
): StoreResult<T> {
  return { ok: false, error: { code, message } };
}
