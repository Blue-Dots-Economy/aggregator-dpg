/**
 * In-memory aggregator-org store.
 *
 * Process-local Map; mirrors the Postgres adapter's external behaviour
 * (partial-slug uniqueness over non-terminal rows, atomic approve/reject
 * guard, lowercased owner email, the Default org skipped by owner lookups,
 * name-sorted active list). It holds aggregator orgs only; the
 * network-facilitator root is a separate slot (see `AggregatorOrgStoreFake`).
 * Unit-test use only.
 */

import { randomUUID } from 'node:crypto';
import { contactId } from '@aggregator-dpg/shared-primitives/contact';
import {
  AggregatorOrgStoreBase,
  DEFAULT_ORG_SLUG,
  type AggregatorOrg,
  type CreateOrgInput,
  type OrgStoreError,
  type OrgStoreResult,
  type UpdateOrgPatch,
} from './interface.js';

const NON_TERMINAL = new Set(['pending', 'active']);

export class InMemoryAggregatorOrgStore extends AggregatorOrgStoreBase {
  protected readonly byId = new Map<string, AggregatorOrg>();
  /** Owner admin-account id per owner contact (one account per person, 0027). */
  protected readonly adminByContact = new Map<string, string>();
  /** Contacts that also hold a coordinator account (see {@link markCoordinator}). */
  protected readonly coordinatorContacts = new Set<string>();
  /** The network-facilitator root, when a test seeds one. */
  protected root: AggregatorOrg | null = null;

  create(input: CreateOrgInput): Promise<OrgStoreResult<AggregatorOrg>> {
    const slugTaken = [...this.byId.values()].some(
      (o) => o.slug === input.slug && NON_TERMINAL.has(o.status),
    );
    if (slugTaken)
      return Promise.resolve(err('DUPLICATE_SLUG', `slug already in use: ${input.slug}`));
    // Case-insensitive display-name uniqueness over non-terminal rows.
    const nameKey = input.displayName.trim().toLowerCase();
    const nameTaken = [...this.byId.values()].some(
      (o) => o.displayName.trim().toLowerCase() === nameKey && NON_TERMINAL.has(o.status),
    );
    if (nameTaken)
      return Promise.resolve(err('DUPLICATE_NAME', `organisation name already in use`));
    let id: string;
    try {
      id = contactId(input.ownerEmail, input.ownerPhone ?? null);
    } catch {
      // Postgres fails the same write (contactId() runs before any SQL).
      return Promise.resolve(err('DB_UNAVAILABLE', 'TypeError'));
    }
    const now = new Date();
    let ownerUserId = this.adminByContact.get(id);
    if (!ownerUserId) {
      ownerUserId = randomUUID();
      this.adminByContact.set(id, ownerUserId);
    }
    const row: AggregatorOrg = {
      id: randomUUID(),
      slug: input.slug,
      displayName: input.displayName,
      state: input.state ?? null,
      contactId: id,
      ownerUserId,
      ownerEmail: input.ownerEmail.toLowerCase(),
      ownerPhone: input.ownerPhone ?? null,
      ownerName: input.ownerName?.trim() ? input.ownerName : null,
      ownerKcSub: input.ownerKcSub ?? null,
      kcGroupId: input.kcGroupId ?? null,
      profile: input.profile ?? {},
      profileRef: input.profileRef ?? null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      rejectedAt: null,
      isDefault: false,
      url: input.url ?? null,
      locations: input.locations ?? [],
      legalName: null,
      gstNumber: null,
    };
    this.byId.set(row.id, row);
    return Promise.resolve({ ok: true, value: row });
  }

  findById(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return Promise.resolve({ ok: true, value: this.byId.get(id) ?? null });
  }

  findBySlug(slug: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return Promise.resolve({
      ok: true,
      value: [...this.byId.values()].find((o) => o.slug === slug) ?? null,
    });
  }

  findByOwnerEmail(email: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    const target = email.toLowerCase();
    return Promise.resolve({
      ok: true,
      value: pickOwned((o) => o.ownerEmail === target && !o.isDefault, this.byId),
    });
  }

  findByOwnerPhone(phone: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return Promise.resolve({
      ok: true,
      value: pickOwned((o) => o.ownerPhone === phone && !o.isDefault, this.byId),
    });
  }

  ownerIsShared(id: string): Promise<OrgStoreResult<boolean>> {
    const owner = this.byId.get(id)?.ownerUserId;
    const shared = [...this.byId.values()].some((o) => o.id !== id && o.ownerUserId === owner);
    const coordinator = [...this.coordinatorContacts].includes(this.byId.get(id)?.contactId ?? '');
    return Promise.resolve({ ok: true, value: owner !== undefined && (shared || coordinator) });
  }

  /** Test helper — marks a person (contact id) as also holding a coordinator account. */
  markCoordinator(contactIdValue: string): void {
    this.coordinatorContacts.add(contactIdValue);
  }

  listActive(): Promise<OrgStoreResult<AggregatorOrg[]>> {
    const rows = [...this.byId.values()]
      .filter((o) => o.status === 'active')
      .sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
    return Promise.resolve({ ok: true, value: rows });
  }

  findDefault(): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return Promise.resolve({
      ok: true,
      value: [...this.byId.values()].find((o) => o.slug === DEFAULT_ORG_SLUG) ?? null,
    });
  }

  findRoot(): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return Promise.resolve({ ok: true, value: this.root });
  }

  listPending(updatedBefore?: Date): Promise<OrgStoreResult<AggregatorOrg[]>> {
    const before = updatedBefore?.getTime();
    const rows = [...this.byId.values()]
      .filter((o) => o.status === 'pending')
      .filter((o) => before === undefined || o.updatedAt.getTime() < before)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return Promise.resolve({ ok: true, value: rows });
  }

  deleteById(id: string): Promise<OrgStoreResult<void>> {
    const gone = this.byId.get(id);
    // As in Postgres: the Default org is never removable here.
    if (gone?.isDefault) return Promise.resolve({ ok: true, value: undefined });
    this.byId.delete(id);
    // Mirror aggregator_orgs_owner_ad: release the owner's account once it
    // owns no other org.
    if (gone && ![...this.byId.values()].some((o) => o.ownerUserId === gone.ownerUserId)) {
      this.adminByContact.delete(gone.contactId);
    }
    return Promise.resolve({ ok: true, value: undefined });
  }

  update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<AggregatorOrg>> {
    const existing = this.byId.get(id);
    if (!existing) return Promise.resolve(err('NOT_FOUND', id));
    const next: AggregatorOrg = {
      ...existing,
      displayName: patch.displayName ?? existing.displayName,
      state: patch.state !== undefined ? patch.state : existing.state,
      // As in Postgres: a recorded login is only ever added, never cleared.
      ownerKcSub: patch.ownerKcSub ? patch.ownerKcSub : existing.ownerKcSub,
      kcGroupId: patch.kcGroupId !== undefined ? patch.kcGroupId : existing.kcGroupId,
      status: patch.status ?? existing.status,
      rejectedAt: patch.rejectedAt !== undefined ? patch.rejectedAt : existing.rejectedAt,
      updatedAt: new Date(),
    };
    this.byId.set(id, next);
    return Promise.resolve({ ok: true, value: next });
  }

  async approve(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.casFromPending(id, 'active');
  }

  async reject(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.casFromPending(id, 'inactive');
  }

  private casFromPending(
    id: string,
    next: AggregatorOrg['status'],
  ): Promise<OrgStoreResult<AggregatorOrg | null>> {
    const existing = this.byId.get(id);
    if (!existing) return Promise.resolve(err('NOT_FOUND', id));
    if (existing.status !== 'pending') return Promise.resolve({ ok: true, value: null });
    const updated: AggregatorOrg = {
      ...existing,
      status: next,
      updatedAt: new Date(),
      // Stamp rejected_at (write-once) on reject only (#726).
      ...(next === 'inactive' ? { rejectedAt: new Date() } : {}),
    };
    this.byId.set(id, updated);
    return Promise.resolve({ ok: true, value: updated });
  }
}

/**
 * The org an owner match resolves to, as in Postgres: live first, then newest.
 */
function pickOwned(
  match: (o: AggregatorOrg) => boolean,
  byId: Map<string, AggregatorOrg>,
): AggregatorOrg | null {
  const live = (o: AggregatorOrg) => (NON_TERMINAL.has(o.status) ? 0 : 1);
  return (
    [...byId.values()]
      .filter(match)
      .sort((a, b) => live(a) - live(b) || b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
  );
}

function err<T>(code: OrgStoreError['code'], message: string): OrgStoreResult<T> {
  return { ok: false, error: { code, message } };
}
