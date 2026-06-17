/**
 * In-memory registration store.
 *
 * Process-local Maps. Suitable for unit tests. Mirrors Postgres adapter
 * semantics: idempotency-key dedup, partial uniqueness on non-terminal
 * email/phone, compare-and-set transition, provision_state patching.
 */

import { randomUUID } from 'node:crypto';
import {
  RegistrationStoreBase,
  type CreateRegistrationInput,
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

export class InMemoryRegistrationStore extends RegistrationStoreBase {
  protected readonly byId = new Map<string, Registration>();
  protected readonly byIdempotencyKey = new Map<string, string>();

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
      provisionState: {},
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
      verificationSentAt: patch.verificationSentAt ?? existing.verificationSentAt,
      verifiedAt: patch.verifiedAt ?? existing.verifiedAt,
      adminNotifiedAt: patch.adminNotifiedAt ?? existing.adminNotifiedAt,
      approvalLinkIssuedAt: patch.approvalLinkIssuedAt ?? existing.approvalLinkIssuedAt,
      reconcilerClaimedAt:
        'reconcilerClaimedAt' in patch
          ? (patch.reconcilerClaimedAt ?? null)
          : existing.reconcilerClaimedAt,
      updatedAt: now,
    };
    this.byId.set(id, next);
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
  ): Promise<StoreResult<void>> {
    const row = this.byId.get(id);
    if (!row) return err('NOT_FOUND', id);
    this.byId.set(id, {
      ...row,
      provisionState: { ...row.provisionState, [key]: status },
      updatedAt: new Date(),
    });
    return { ok: true, value: undefined };
  }

  /** Reset all state between tests. */
  reset(): void {
    this.byId.clear();
    this.byIdempotencyKey.clear();
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
