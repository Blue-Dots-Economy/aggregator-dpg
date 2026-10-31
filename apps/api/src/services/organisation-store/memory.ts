/**
 * In-memory organisation store for unit tests, in `@aggregator-dpg/api`.
 *
 * Matches the Postgres adapter's behaviour: slug uniqueness over live rows,
 * atomic approve/reject, lowercased owner email, Default org skipped by owner
 * lookups. It holds aggregator orgs only; the root is a separate slot (see
 * `OrganisationStoreFake`).
 */

import { randomUUID } from 'node:crypto';
import { contactId } from '@aggregator-dpg/shared-primitives/contact';
import {
  OrganisationStoreBase,
  DEFAULT_ORG_SLUG,
  type Organisation,
  type CreateOrgInput,
  type OrgStoreError,
  type OrgStoreResult,
  type UpdateOrgPatch,
  type OrgDeleteIfPendingOutcome,
  type SearchOrgsFilter,
  type SearchOrgsPage,
} from './interface.js';

const NON_TERMINAL = new Set(['pending', 'active']);

export class InMemoryOrganisationStore extends OrganisationStoreBase {
  protected readonly byId = new Map<string, Organisation>();
  /** Owner admin-account id per owner contact (one account per person). */
  protected readonly adminByContact = new Map<string, string>();
  /** Contacts that also hold a coordinator account (see {@link markCoordinator}). */
  protected readonly coordinatorContacts = new Set<string>();
  /** The network-facilitator root, when a test seeds one. */
  protected root: Organisation | null = null;

  async create(input: CreateOrgInput): Promise<OrgStoreResult<Organisation>> {
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
    // Nothing is stored when the consent write fails.
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
    const row: Organisation = {
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
      locations: input.locations ?? [],
      legalName: null,
      description: null,
    };
    this.byId.set(row.id, row);
    return { ok: true, value: row };
  }

  findById(id: string): Promise<OrgStoreResult<Organisation | null>> {
    return Promise.resolve({ ok: true, value: this.byId.get(id) ?? null });
  }

  findBySlug(slug: string): Promise<OrgStoreResult<Organisation | null>> {
    return Promise.resolve({
      ok: true,
      value: [...this.byId.values()].find((o) => o.slug === slug) ?? null,
    });
  }

  findByOwnerEmail(email: string): Promise<OrgStoreResult<Organisation | null>> {
    const target = email.toLowerCase();
    return Promise.resolve({
      ok: true,
      value: pickOwned((o) => o.ownerEmail === target && !o.isDefault, this.byId),
    });
  }

  findByOwnerPhone(phone: string): Promise<OrgStoreResult<Organisation | null>> {
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

  listActive(): Promise<OrgStoreResult<Organisation[]>> {
    const rows = [...this.byId.values()]
      .filter((o) => o.status === 'active')
      .sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
    return Promise.resolve({ ok: true, value: rows });
  }

  findDefault(): Promise<OrgStoreResult<Organisation | null>> {
    return Promise.resolve({
      ok: true,
      value: [...this.byId.values()].find((o) => o.slug === DEFAULT_ORG_SLUG) ?? null,
    });
  }

  findRoot(): Promise<OrgStoreResult<Organisation | null>> {
    return Promise.resolve({ ok: true, value: this.root });
  }

  listPending(updatedBefore?: Date): Promise<OrgStoreResult<Organisation[]>> {
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
    // Release the owner's account once it owns no other org, as the database trigger does.
    if (gone && ![...this.byId.values()].some((o) => o.ownerUserId === gone.ownerUserId)) {
      this.adminByContact.delete(gone.contactId);
    }
    return Promise.resolve({ ok: true, value: undefined });
  }

  update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<Organisation>> {
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
    const next: Organisation = {
      ...existing,
      displayName: patch.displayName ?? existing.displayName,
      locations: patch.locations ?? existing.locations,
      legalName: patch.legalName !== undefined ? patch.legalName : existing.legalName,
      description: patch.description !== undefined ? patch.description : existing.description,
      profile: patch.profileMerge
        ? mergeProfile(existing.profile, patch.profileMerge)
        : existing.profile,
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

  async approve(id: string, updatedBy: string): Promise<OrgStoreResult<Organisation | null>> {
    return this.casFromPending(id, 'active', updatedBy);
  }

  async reject(id: string, updatedBy: string): Promise<OrgStoreResult<Organisation | null>> {
    return this.casFromPending(id, 'inactive', updatedBy);
  }

  listOwnedBy(ownerUserId: string): Promise<OrgStoreResult<Organisation[]>> {
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
      row?.status !== 'pending' ||
      row?.isDefault ||
      (row?.updatedAt.getTime() ?? 0) >= cutoff.getTime()
    ) {
      return { ok: true, value: 'not_pending' };
    }
    if (!(await beforeCommit())) return { ok: true, value: 'aborted' };
    this.byId.delete(id);
    return { ok: true, value: 'deleted' };
  }

  private casFromPending(
    id: string,
    next: Organisation['status'],
    updatedBy: string,
  ): Promise<OrgStoreResult<Organisation | null>> {
    const existing = this.byId.get(id);
    if (!existing) return Promise.resolve(err('NOT_FOUND', id));
    if (existing.status !== 'pending') return Promise.resolve({ ok: true, value: null });
    const updated: Organisation = {
      ...existing,
      status: next,
      updatedAt: new Date(),
      updatedBy,
      // Stamp the write-once rejected_at on reject only.
      ...(next === 'inactive' ? { rejectedAt: new Date() } : {}),
    };
    this.byId.set(id, updated);
    return Promise.resolve({ ok: true, value: updated });
  }
}

/** Picks the org an owner match resolves to: live first, then newest. */
function pickOwned(
  match: (o: Organisation) => boolean,
  byId: Map<string, Organisation>,
): Organisation | null {
  const live = (o: Organisation) => (NON_TERMINAL.has(o.status) ? 0 : 1);
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
function byName(a: Organisation, b: Organisation): number {
  const an = a.displayName.toLowerCase();
  const bn = b.displayName.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

/**
 * Merges `merge` into `profile`: non-null values replace, `null` removes the key.
 *
 * @param profile - The stored profile.
 * @param merge - Keys to set or remove.
 * @returns A new profile object.
 */
function mergeProfile(
  profile: Record<string, unknown>,
  merge: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...profile };
  for (const [key, value] of Object.entries(merge)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}
