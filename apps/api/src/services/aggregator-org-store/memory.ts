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
  type OrgDeleteIfPendingOutcome,
  type SearchOrgsFilter,
  type SearchOrgsPage,
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

  async create(input: CreateOrgInput): Promise<OrgStoreResult<AggregatorOrg>> {
    const slugTaken = [...this.byId.values()].some(
      (o) => o.slug === input.slug && NON_TERMINAL.has(o.status),
    );
    if (slugTaken) return err('DUPLICATE_SLUG', `slug already in use: ${input.slug}`);
    // Case-insensitive display-name uniqueness over non-terminal rows.
    const nameKey = input.displayName.trim().toLowerCase();
    const nameTaken = [...this.byId.values()].some(
      (o) => o.displayName.trim().toLowerCase() === nameKey && NON_TERMINAL.has(o.status),
    );
    if (nameTaken) return err('DUPLICATE_NAME', `organisation name already in use`);
    let id: string;
    try {
      id = contactId(input.ownerEmail, input.ownerPhone ?? null);
    } catch {
      // Postgres fails the same write (contactId() runs before any SQL).
      return err('DB_UNAVAILABLE', 'TypeError');
    }
    const orgId = randomUUID();
    // Fail-closed like the Postgres transaction: nothing is stored when the
    // consent write fails.
    if (input.recordConsent) {
      try {
        await input.recordConsent(undefined, orgId);
      } catch {
        return err('CONSENT_WRITE_FAILED', 'consent could not be recorded');
      }
    }
    const now = new Date();
    let ownerUserId = this.adminByContact.get(id);
    if (!ownerUserId) {
      ownerUserId = randomUUID();
      this.adminByContact.set(id, ownerUserId);
    }
    const row: AggregatorOrg = {
      id: orgId,
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
      updatedBy: 'self',
      rejectedAt: null,
      isDefault: false,
      url: input.url ?? null,
      locations: input.locations ?? [],
      legalName: null,
      gstNumber: null,
    };
    this.byId.set(row.id, row);
    return { ok: true, value: row };
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
    if (patch.displayName !== undefined) {
      // As in Postgres: names are unique (case-insensitively) among live orgs.
      const key = patch.displayName.trim().toLowerCase();
      const taken = [...this.byId.values()].some(
        (o) =>
          o.id !== id && o.displayName.trim().toLowerCase() === key && NON_TERMINAL.has(o.status),
      );
      if (taken) return Promise.resolve(err('DUPLICATE_NAME', 'organisation name already in use'));
    }
    const next: AggregatorOrg = {
      ...existing,
      displayName: patch.displayName ?? existing.displayName,
      url: patch.url !== undefined ? patch.url : existing.url,
      locations: patch.locations ?? existing.locations,
      legalName: patch.legalName !== undefined ? patch.legalName : existing.legalName,
      gstNumber: patch.gstNumber !== undefined ? patch.gstNumber : existing.gstNumber,
      state: patch.state !== undefined ? patch.state : existing.state,
      // As in Postgres: a recorded login is only ever added, never cleared.
      ownerKcSub: patch.ownerKcSub ? patch.ownerKcSub : existing.ownerKcSub,
      kcGroupId: patch.kcGroupId !== undefined ? patch.kcGroupId : existing.kcGroupId,
      status: patch.status ?? existing.status,
      rejectedAt: patch.rejectedAt !== undefined ? patch.rejectedAt : existing.rejectedAt,
      updatedBy: patch.updatedBy ?? existing.updatedBy,
      updatedAt: new Date(),
    };
    this.byId.set(id, next);
    return Promise.resolve({ ok: true, value: next });
  }

  async approve(id: string, updatedBy: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.casFromPending(id, 'active', updatedBy);
  }

  async reject(id: string, updatedBy: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.casFromPending(id, 'inactive', updatedBy);
  }

  listOwnedBy(ownerUserId: string): Promise<OrgStoreResult<AggregatorOrg[]>> {
    const rows = [...this.byId.values()].filter((o) => o.ownerUserId === ownerUserId).sort(byName);
    return Promise.resolve({ ok: true, value: rows });
  }

  search(filter: SearchOrgsFilter): Promise<OrgStoreResult<SearchOrgsPage>> {
    const limit = Math.max(1, Math.min(100, filter.limit ?? 20));
    let rows = [...this.byId.values()];
    if (filter.orgIds !== null) {
      const scope = new Set(filter.orgIds);
      rows = rows.filter((o) => scope.has(o.id));
    }
    if (filter.status) rows = rows.filter((o) => o.status === filter.status);
    if (filter.namePrefix) {
      const p = filter.namePrefix.toLowerCase();
      rows = rows.filter((o) => o.displayName.toLowerCase().startsWith(p));
    }
    rows.sort(byName);
    if (filter.cursor) {
      const c = { name: filter.cursor.name.toLowerCase(), id: filter.cursor.id };
      rows = rows.filter((o) => {
        const n = o.displayName.toLowerCase();
        return n > c.name || (n === c.name && o.id > c.id);
      });
    }
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return Promise.resolve({
      ok: true,
      value: {
        rows: page,
        nextCursor: rows.length > limit && last ? { name: last.displayName, id: last.id } : null,
      },
    });
  }

  async deleteIfPending(
    id: string,
    cutoff: Date,
    beforeCommit: () => Promise<boolean>,
  ): Promise<OrgStoreResult<OrgDeleteIfPendingOutcome>> {
    const row = this.byId.get(id);
    if (
      !row ||
      row.status !== 'pending' ||
      row.isDefault ||
      row.updatedAt.getTime() >= cutoff.getTime()
    ) {
      return { ok: true, value: 'not_pending' };
    }
    if (!(await beforeCommit())) return { ok: true, value: 'aborted' };
    this.byId.delete(id);
    return { ok: true, value: 'deleted' };
  }

  private casFromPending(
    id: string,
    next: AggregatorOrg['status'],
    updatedBy: string,
  ): Promise<OrgStoreResult<AggregatorOrg | null>> {
    const existing = this.byId.get(id);
    if (!existing) return Promise.resolve(err('NOT_FOUND', id));
    if (existing.status !== 'pending') return Promise.resolve({ ok: true, value: null });
    const updated: AggregatorOrg = {
      ...existing,
      status: next,
      updatedAt: new Date(),
      updatedBy,
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

/** Orders orgs as Postgres does: lower(name), then id. */
function byName(a: AggregatorOrg, b: AggregatorOrg): number {
  const an = a.displayName.toLowerCase();
  const bn = b.displayName.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
