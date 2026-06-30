/**
 * In-memory aggregator-org store.
 *
 * Process-local Map; mirrors the Postgres adapter's external behaviour
 * (partial-slug uniqueness over non-terminal rows, atomic approve/reject
 * guard, lowercased owner email). Unit-test use only.
 */

import { randomUUID } from 'node:crypto';
import {
  AggregatorOrgStoreBase,
  type AggregatorOrg,
  type CreateOrgInput,
  type OrgStoreError,
  type OrgStoreResult,
  type UpdateOrgPatch,
} from './interface.js';

const NON_TERMINAL = new Set(['pending', 'active']);

export class InMemoryAggregatorOrgStore extends AggregatorOrgStoreBase {
  protected readonly byId = new Map<string, AggregatorOrg>();

  async create(input: CreateOrgInput): Promise<OrgStoreResult<AggregatorOrg>> {
    const slugTaken = [...this.byId.values()].some(
      (o) => o.slug === input.slug && NON_TERMINAL.has(o.status),
    );
    if (slugTaken) return err('DUPLICATE_SLUG', `slug already in use: ${input.slug}`);
    const now = new Date();
    const row: AggregatorOrg = {
      id: randomUUID(),
      slug: input.slug,
      displayName: input.displayName,
      state: input.state ?? null,
      ownerEmail: input.ownerEmail.toLowerCase(),
      ownerKcSub: input.ownerKcSub ?? null,
      kcGroupId: input.kcGroupId ?? null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(row.id, row);
    return { ok: true, value: row };
  }

  async findById(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return { ok: true, value: this.byId.get(id) ?? null };
  }

  async findBySlug(slug: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return { ok: true, value: [...this.byId.values()].find((o) => o.slug === slug) ?? null };
  }

  async findByOwnerEmail(email: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    const target = email.toLowerCase();
    return {
      ok: true,
      value: [...this.byId.values()].find((o) => o.ownerEmail === target) ?? null,
    };
  }

  async listActive(): Promise<OrgStoreResult<AggregatorOrg[]>> {
    const rows = [...this.byId.values()]
      .filter((o) => o.status === 'active')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return { ok: true, value: rows };
  }

  async update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<AggregatorOrg>> {
    const existing = this.byId.get(id);
    if (!existing) return err('NOT_FOUND', id);
    const next: AggregatorOrg = {
      ...existing,
      displayName: patch.displayName ?? existing.displayName,
      state: patch.state !== undefined ? patch.state : existing.state,
      ownerKcSub: patch.ownerKcSub !== undefined ? patch.ownerKcSub : existing.ownerKcSub,
      kcGroupId: patch.kcGroupId !== undefined ? patch.kcGroupId : existing.kcGroupId,
      status: patch.status ?? existing.status,
      updatedAt: new Date(),
    };
    this.byId.set(id, next);
    return { ok: true, value: next };
  }

  async approve(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.casFromPending(id, 'active');
  }

  async reject(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.casFromPending(id, 'inactive');
  }

  private async casFromPending(
    id: string,
    next: AggregatorOrg['status'],
  ): Promise<OrgStoreResult<AggregatorOrg | null>> {
    const existing = this.byId.get(id);
    if (!existing) return err('NOT_FOUND', id);
    if (existing.status !== 'pending') return { ok: true, value: null };
    const updated: AggregatorOrg = { ...existing, status: next, updatedAt: new Date() };
    this.byId.set(id, updated);
    return { ok: true, value: updated };
  }
}

function err<T>(code: OrgStoreError['code'], message: string): OrgStoreResult<T> {
  return { ok: false, error: { code, message } };
}
