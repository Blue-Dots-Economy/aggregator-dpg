/**
 * In-memory registration-invites store for unit tests (`@aggregator-dpg/api`).
 *
 * Behaves like the Postgres store: one pending invite per org, role and email,
 * atomic consume and revoke, refresh only while pending. Other modules use
 * `RegistrationInvitesStoreFake` from `./testing`.
 */

import { randomUUID } from 'node:crypto';
import {
  RegistrationInvitesStoreBase,
  type CreateInviteInput,
  type InviteRole,
  type ListOpenInvitesInput,
  type InviteStoreResult,
  type RefreshInviteInput,
  type RegistrationInvite,
} from './interface.js';

export class InMemoryRegistrationInvitesStore extends RegistrationInvitesStoreBase {
  protected store = new Map<string, RegistrationInvite>();

  async create(input: CreateInviteInput): Promise<InviteStoreResult<RegistrationInvite>> {
    for (const inv of this.store.values()) {
      if (
        inv.parentOrgId === input.parentOrgId &&
        inv.role === (input.role ?? 'coordinator') &&
        inv.email === input.email &&
        inv.status === 'pending'
      ) {
        return {
          ok: false,
          error: { code: 'DUPLICATE_PENDING', message: 'a live invite already exists' },
        };
      }
    }
    const jti = randomUUID();
    const row: RegistrationInvite = {
      jti,
      role: input.role ?? 'coordinator',
      parentOrgId: input.parentOrgId,
      email: input.email,
      status: 'pending',
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
      createdAt: new Date(),
      consumedAt: null,
    };
    this.store.set(jti, row);
    return { ok: true, value: { ...row } };
  }

  async findByJti(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>> {
    const row = this.store.get(jti);
    return { ok: true, value: row ? { ...row } : null };
  }

  async findPendingByOrgAndEmail(
    parentOrgId: string,
    role: InviteRole,
    email: string,
  ): Promise<InviteStoreResult<RegistrationInvite | null>> {
    for (const inv of this.store.values()) {
      if (
        inv.parentOrgId === parentOrgId &&
        inv.role === role &&
        inv.email === email &&
        inv.status === 'pending'
      ) {
        return { ok: true, value: { ...inv } };
      }
    }
    return { ok: true, value: null };
  }

  async listOpen(input: ListOpenInvitesInput): Promise<InviteStoreResult<RegistrationInvite[]>> {
    const after = input.after;
    const rows = [...this.store.values()]
      .filter(
        (inv) =>
          inv.parentOrgId === input.orgId &&
          inv.role === input.role &&
          (inv.status === 'pending' || inv.status === 'expired'),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.jti < b.jti ? 1 : -1))
      .filter(
        (inv) =>
          !after ||
          inv.createdAt.getTime() < after.createdAt.getTime() ||
          (inv.createdAt.getTime() === after.createdAt.getTime() && inv.jti < after.jti),
      )
      .slice(0, input.limit);
    return { ok: true, value: rows.map((r) => ({ ...r })) };
  }

  async refresh(
    jti: string,
    input: RefreshInviteInput,
  ): Promise<InviteStoreResult<RegistrationInvite>> {
    const row = this.store.get(jti);
    if (row?.status !== 'pending') {
      return { ok: false, error: { code: 'NOT_FOUND', message: jti } };
    }
    row.expiresAt = input.expiresAt;
    row.createdBy = input.createdBy;
    return { ok: true, value: { ...row } };
  }

  async consume(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>> {
    const row = this.store.get(jti);
    if (row?.status !== 'pending') return { ok: true, value: null };
    row.status = 'consumed';
    row.consumedAt = new Date();
    return { ok: true, value: { ...row } };
  }

  async revoke(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>> {
    const row = this.store.get(jti);
    if (row?.status !== 'pending') return { ok: true, value: null };
    row.status = 'revoked';
    return { ok: true, value: { ...row } };
  }

  async release(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>> {
    const row = this.store.get(jti);
    if (row?.status !== 'consumed') return { ok: true, value: null };
    row.status = 'pending';
    row.consumedAt = null;
    return { ok: true, value: { ...row } };
  }
}
