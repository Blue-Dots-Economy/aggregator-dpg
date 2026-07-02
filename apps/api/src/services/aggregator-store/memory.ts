/**
 * In-memory aggregator store.
 *
 * Process-local Maps, suitable for unit tests. Mirrors the Postgres adapter's
 * external behaviour: unique slug / phone / email, conditional `actor_type ↔
 * type` invariant, immutable slug on update.
 */

import { randomUUID } from 'node:crypto';
import {
  AggregatorStoreBase,
  type Aggregator,
  type CreateAggregatorInput,
  type ListAggregatorsFilter,
  type ListAggregatorsPage,
  type StoreError,
  type StoreResult,
  type UpdateAggregatorPatch,
} from './interface.js';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';

export class InMemoryAggregatorStore extends AggregatorStoreBase {
  protected readonly byId = new Map<string, Aggregator>();
  protected readonly bySlug = new Map<string, string>();
  protected readonly byPhone = new Map<string, string>();
  protected readonly byEmail = new Map<string, string>();

  async create(input: CreateAggregatorInput): Promise<StoreResult<Aggregator>> {
    const invariant = checkInvariant(input.actorType, input.type);
    if (invariant) return { ok: false, error: invariant };

    if (this.bySlug.has(input.orgSlug)) {
      return errResult('DUPLICATE_SLUG', `slug already exists: ${input.orgSlug}`);
    }
    const phone = input.contact.phone;
    const email = input.contact.email.toLowerCase();
    if (this.byPhone.has(phone)) {
      return errResult('DUPLICATE_PHONE', `phone already exists: ${phone}`);
    }
    if (this.byEmail.has(email)) {
      return errResult('DUPLICATE_EMAIL', `email already exists: ${email}`);
    }

    const now = new Date();
    const row: Aggregator = {
      id: randomUUID(),
      orgSlug: input.orgSlug,
      actorType: input.actorType,
      name: input.name,
      type: input.type,
      url: input.url ?? null,
      contact: input.contact,
      contactPhone: phone,
      contactEmail: email,
      locations: input.locations ?? [],
      consent: input.consent,
      status: 'pending',
      createdBy: input.createdBy,
      updatedBy: input.updatedBy,
      createdAt: now,
      updatedAt: now,
      signalstackOrgId: null,
      parentOrgId: input.parentOrgId ?? null,
    };
    this.indexInsert(row);
    return { ok: true, value: row };
  }

  async findById(id: string): Promise<StoreResult<Aggregator | null>> {
    return { ok: true, value: this.byId.get(id) ?? null };
  }

  async findBySlug(orgSlug: string): Promise<StoreResult<Aggregator | null>> {
    const id = this.bySlug.get(orgSlug);
    return { ok: true, value: id ? (this.byId.get(id) ?? null) : null };
  }

  async findByContactPhone(phone: string): Promise<StoreResult<Aggregator | null>> {
    const id = this.byPhone.get(phone);
    return { ok: true, value: id ? (this.byId.get(id) ?? null) : null };
  }

  async findByContactEmail(email: string): Promise<StoreResult<Aggregator | null>> {
    const id = this.byEmail.get(email.toLowerCase());
    return { ok: true, value: id ? (this.byId.get(id) ?? null) : null };
  }

  async findByParentOrgId(orgId: string): Promise<StoreResult<Aggregator[]>> {
    return {
      ok: true,
      value: [...this.byId.values()].filter((r) => r.parentOrgId === orgId),
    };
  }

  async list(filter: ListAggregatorsFilter): Promise<StoreResult<ListAggregatorsPage>> {
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    let rows = [...this.byId.values()];
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.actorType) rows = rows.filter((r) => r.actorType === filter.actorType);
    if (filter.updatedBefore) {
      const before = filter.updatedBefore.getTime();
      rows = rows.filter((r) => r.updatedAt.getTime() < before);
    }
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      ok: true,
      value: { rows: rows.slice(offset, offset + limit), total: rows.length },
    };
  }

  async update(id: string, patch: UpdateAggregatorPatch): Promise<StoreResult<Aggregator>> {
    const existing = this.byId.get(id);
    if (!existing) return errResult('NOT_FOUND', id);

    const nextActorType = existing.actorType;
    const nextType = patch.type !== undefined ? patch.type : existing.type;
    const invariant = checkInvariant(nextActorType, nextType);
    if (invariant) return { ok: false, error: invariant };

    let nextPhone = existing.contactPhone;
    let nextEmail = existing.contactEmail;
    let nextContact = existing.contact;
    if (patch.contact) {
      nextContact = patch.contact;
      nextPhone = patch.contact.phone;
      nextEmail = patch.contact.email.toLowerCase();
      if (nextPhone !== existing.contactPhone && this.byPhone.has(nextPhone)) {
        return errResult('DUPLICATE_PHONE', `phone already exists: ${nextPhone}`);
      }
      if (nextEmail !== existing.contactEmail && this.byEmail.has(nextEmail)) {
        return errResult('DUPLICATE_EMAIL', `email already exists: ${nextEmail}`);
      }
    }

    const next: Aggregator = {
      ...existing,
      name: patch.name ?? existing.name,
      type: patch.type !== undefined ? patch.type : existing.type,
      url: patch.url !== undefined ? patch.url : existing.url,
      contact: nextContact,
      contactPhone: nextPhone,
      contactEmail: nextEmail,
      locations: patch.locations ?? existing.locations,
      consent: patch.consent ?? existing.consent,
      status: patch.status ?? existing.status,
      parentOrgId: patch.parentOrgId !== undefined ? patch.parentOrgId : existing.parentOrgId,
      updatedBy: patch.updatedBy,
      updatedAt: new Date(),
    };
    this.indexReplace(existing, next);
    return { ok: true, value: next };
  }

  async updateStatus(
    id: string,
    status: AggregatorStatus,
    updatedBy: string,
  ): Promise<StoreResult<Aggregator>> {
    return this.update(id, { status, updatedBy });
  }

  async approveFromPending(id: string, updatedBy: string): Promise<StoreResult<Aggregator | null>> {
    const existing = this.byId.get(id);
    // Only pending → active; anything else means already decided.
    if (!existing || existing.status !== 'pending') return { ok: true, value: null };
    return this.update(id, { status: 'active', updatedBy });
  }

  async updateSignalstackOrgId(
    id: string,
    signalstackOrgId: string,
    updatedBy: string,
  ): Promise<StoreResult<Aggregator>> {
    const existing = this.byId.get(id);
    if (!existing) return errResult('NOT_FOUND', id);
    const next: Aggregator = {
      ...existing,
      signalstackOrgId,
      updatedBy,
      updatedAt: new Date(),
    };
    this.byId.set(id, next);
    return { ok: true, value: next };
  }

  async deleteById(id: string): Promise<StoreResult<void>> {
    const row = this.byId.get(id);
    if (!row) return errResult('NOT_FOUND', id);
    this.byId.delete(id);
    this.bySlug.delete(row.orgSlug);
    this.byPhone.delete(row.contactPhone);
    this.byEmail.delete(row.contactEmail);
    return { ok: true, value: undefined };
  }

  // ─── Index maintenance ────────────────────────────────────────────────────

  protected indexInsert(row: Aggregator): void {
    this.byId.set(row.id, row);
    this.bySlug.set(row.orgSlug, row.id);
    this.byPhone.set(row.contactPhone, row.id);
    this.byEmail.set(row.contactEmail, row.id);
  }

  protected indexReplace(prev: Aggregator, next: Aggregator): void {
    this.byId.set(next.id, next);
    if (prev.contactPhone !== next.contactPhone) {
      this.byPhone.delete(prev.contactPhone);
      this.byPhone.set(next.contactPhone, next.id);
    }
    if (prev.contactEmail !== next.contactEmail) {
      this.byEmail.delete(prev.contactEmail);
      this.byEmail.set(next.contactEmail, next.id);
    }
    // org_slug is immutable — no maintenance needed.
  }
}

function checkInvariant(
  actorType: Aggregator['actorType'],
  type: Aggregator['type'],
): StoreError | null {
  // Migration 0006 relaxed the invariant: aggregator actors may carry any
  // role-type (including null); seeker/provider actors must mirror their
  // actor_type in `type`.
  if (actorType === 'seeker' && type !== 'seeker') {
    return {
      code: 'CHECK_VIOLATION',
      message: 'type must equal "seeker" when actor_type=seeker',
    };
  }
  if (actorType === 'provider' && type !== 'provider') {
    return {
      code: 'CHECK_VIOLATION',
      message: 'type must equal "provider" when actor_type=provider',
    };
  }
  return null;
}

function errResult<T>(code: StoreError['code'], message: string): StoreResult<T> {
  return { ok: false, error: { code, message } as StoreError };
}
