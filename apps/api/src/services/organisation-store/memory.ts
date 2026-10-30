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
  type TreeRules,
} from './interface.js';
import {
  DESCENDANT_LEVEL_CAP,
  buildTree,
  counts,
  moveRefusal,
  newChildRefusal,
  parentOptionRefusal,
  subtree,
  type Tree,
} from './tree.js';

const NON_TERMINAL = new Set(['pending', 'active']);

export class InMemoryOrganisationStore extends OrganisationStoreBase {
  protected readonly byId = new Map<string, Organisation>();
  /** Owner admin-account id per owner contact (one account per person). */
  protected readonly adminByContact = new Map<string, string>();
  /** Contacts that also hold a coordinator account (see {@link markCoordinator}). */
  protected readonly coordinatorContacts = new Set<string>();
  /** The network-facilitator root, when a test seeds one. */
  protected root: Organisation | null = null;
  /** Tail of the tree-lock queue; see {@link withTreeLock}. */
  private treeLock: Promise<unknown> = Promise.resolve();

  create(input: CreateOrgInput, rules: TreeRules): Promise<OrgStoreResult<Organisation>> {
    return this.withTreeLock(() => this.createLocked(input, rules));
  }

  private async createLocked(
    input: CreateOrgInput,
    rules: TreeRules,
  ): Promise<OrgStoreResult<Organisation>> {
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
    const parent = this.resolveParent(input.parentId);
    if (input.parentId !== undefined && !parent) {
      return err('INVALID_PARENT', 'parent is not the root or an active organisation');
    }
    const depth = (parent?.depth ?? 0) + 1;
    const refused = this.limitRefusal(parent?.id ?? null, depth - 1, rules);
    if (refused) return err(refused, 'organisation tree limit reached');
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
      url: input.url ?? null,
      locations: input.locations ?? [],
      legalName: null,
      gstNumber: null,
      knownAs: rules.suggestFor(depth),
      depth,
      parentId: parent?.id ?? null,
      parentName: parent?.displayName ?? null,
    };
    this.byId.set(row.id, row);
    return { ok: true, value: row };
  }

  revive(
    id: string,
    parentId: string | undefined,
    rules: TreeRules,
  ): Promise<OrgStoreResult<Organisation>> {
    return this.withTreeLock(() => {
      const org = this.byId.get(id);
      if (org?.status !== 'inactive') return Promise.resolve(err('NOT_FOUND', id));
      if (this.treeSnapshot().children.has(id)) {
        return Promise.resolve(err('NOT_MOVABLE', 'a rejected org with child orgs'));
      }
      const parent = this.resolveParent(parentId);
      if (parentId !== undefined && !parent) {
        return Promise.resolve(
          err('INVALID_PARENT', 'parent is not the root or an active organisation'),
        );
      }
      const depth = (parent?.depth ?? 0) + 1;
      const refused = this.limitRefusal(parent?.id ?? null, depth - 1, rules);
      if (refused) return Promise.resolve(err(refused, 'organisation tree limit reached'));
      const next: Organisation = {
        ...org,
        parentId: parent?.id ?? null,
        parentName: parent?.displayName ?? null,
        depth,
        knownAs: rules.knownAsAllowed(org.knownAs, depth) ? org.knownAs : rules.suggestFor(depth),
        status: 'pending',
        rejectedAt: null,
        updatedAt: new Date(),
      };
      this.byId.set(id, next);
      return Promise.resolve({ ok: true, value: next });
    });
  }

  move(
    id: string,
    change: { parentId: string; knownAs?: string },
    rules: TreeRules,
  ): Promise<
    OrgStoreResult<{ org: Organisation; oldParentId: string | null; movedCount: number }>
  > {
    return this.withTreeLock(() => Promise.resolve(this.moveLocked(id, change, rules)));
  }

  private moveLocked(
    id: string,
    change: { parentId: string; knownAs?: string },
    rules: TreeRules,
  ): OrgStoreResult<{ org: Organisation; oldParentId: string | null; movedCount: number }> {
    const tree = this.treeSnapshot();
    const refused = moveRefusal(tree, id, change.parentId, rules);
    if (refused) return err(refused, refused === 'NOT_FOUND' ? id : 'move refused');
    const org = this.byId.get(id)!;
    const oldParentId = org.parentId;
    if (org.parentId === change.parentId) {
      if (change.knownAs === undefined) {
        return { ok: true, value: { org, oldParentId, movedCount: 0 } };
      }
      if (!rules.knownAsAllowed(change.knownAs, org.depth)) return knownAsDepth([id]);
      const next = { ...org, knownAs: change.knownAs, updatedAt: new Date() };
      this.byId.set(id, next);
      return { ok: true, value: { org: next, oldParentId, movedCount: 0 } };
    }
    const delta = tree.byId.get(change.parentId)!.depth + 1 - org.depth;
    const moved = subtree(tree, id).map((n) => {
      const row = this.byId.get(n.id)!;
      return n.id === id
        ? {
            ...row,
            ...this.parentFields(change.parentId),
            knownAs: change.knownAs ?? row.knownAs,
            depth: row.depth + delta,
            updatedAt: new Date(),
          }
        : { ...row, depth: row.depth + delta };
    });
    const failing = moved.filter((o) => !rules.knownAsAllowed(o.knownAs, o.depth)).map((o) => o.id);
    if (failing.length > 0) return knownAsDepth(failing);
    for (const o of moved) this.byId.set(o.id, o);
    return { ok: true, value: { org: moved[0]!, oldParentId, movedCount: moved.length } };
  }

  parentOptions(
    id: string,
    rules: TreeRules,
  ): Promise<
    OrgStoreResult<{
      subtreeSize: number;
      options: Array<{ org: Organisation; ok: boolean; reason: OrgStoreError['code'] | null }>;
    }>
  > {
    if (!this.byId.has(id)) return Promise.resolve(err('NOT_FOUND', id));
    const tree = this.treeSnapshot();
    // The root first, then by name, as Postgres orders them.
    const candidates = [
      ...(this.root ? [this.root] : []),
      ...[...this.byId.values()].sort(byName),
    ].filter((o) => o.id !== id);
    const options = candidates.map((o) => {
      const reason = parentOptionRefusal(tree, id, o.id, rules);
      return { org: o, ok: reason === null, reason };
    });
    return Promise.resolve({
      ok: true,
      value: { subtreeSize: subtree(tree, id).length, options },
    });
  }

  childCounts(ids: readonly string[]): Promise<OrgStoreResult<Record<string, number>>> {
    const out: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const o of this.byId.values()) {
      if (o.parentId !== null && o.parentId in out && counts(o)) out[o.parentId]! += 1;
    }
    return Promise.resolve({ ok: true, value: out });
  }

  countTotal(): Promise<OrgStoreResult<number>> {
    return Promise.resolve({ ok: true, value: [...this.byId.values()].filter(counts).length });
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

  update(
    id: string,
    patch: UpdateOrgPatch,
    rules?: TreeRules,
  ): Promise<OrgStoreResult<Organisation>> {
    if (patch.knownAs === undefined) return Promise.resolve(this.updateNow(id, patch));
    return this.withTreeLock(() => Promise.resolve(this.updateNow(id, patch, rules)));
  }

  /**
   * Applies an update; with `patch.knownAs`, the caller holds the tree lock.
   *
   * @param id - The org id.
   * @param patch - The fields to change.
   * @param rules - "Known as" rules; a key is refused without them.
   * @returns The updated org.
   */
  private updateNow(
    id: string,
    patch: UpdateOrgPatch,
    rules?: TreeRules,
  ): OrgStoreResult<Organisation> {
    const existing = this.byId.get(id);
    if (!existing) return err('NOT_FOUND', id);
    if (patch.knownAs !== undefined && !rules?.knownAsAllowed(patch.knownAs, existing.depth)) {
      return knownAsDepth([id]);
    }
    if (patch.displayName !== undefined) {
      // As in Postgres: names are unique (case-insensitively) among live orgs.
      const key = patch.displayName.trim().toLowerCase();
      const taken = [...this.byId.values()].some(
        (o) =>
          o.id !== id && o.displayName.trim().toLowerCase() === key && NON_TERMINAL.has(o.status),
      );
      if (taken) return err('DUPLICATE_NAME', 'organisation name already in use');
    }
    const next: Organisation = {
      ...existing,
      displayName: patch.displayName ?? existing.displayName,
      url: patch.url !== undefined ? patch.url : existing.url,
      locations: patch.locations ?? existing.locations,
      legalName: patch.legalName !== undefined ? patch.legalName : existing.legalName,
      gstNumber: patch.gstNumber !== undefined ? patch.gstNumber : existing.gstNumber,
      knownAs: patch.knownAs ?? existing.knownAs,
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
    return { ok: true, value: next };
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
    if (filter.knownAs) rows = rows.filter((o) => o.knownAs === filter.knownAs);
    if (filter.descendantsOf) {
      const below = this.descendantIdsOf(filter.descendantsOf);
      rows = rows.filter((o) => below.has(o.id));
    }
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

  descendantIds(ids: readonly string[]): Promise<OrgStoreResult<string[]>> {
    const found = new Set<string>();
    for (const id of ids) for (const d of this.descendantIdsOf(id)) found.add(d);
    for (const id of ids) found.delete(id);
    return Promise.resolve({ ok: true, value: [...found] });
  }

  countByKnownAs(): Promise<OrgStoreResult<Record<string, number>>> {
    const counts: Record<string, number> = {};
    for (const o of this.byId.values()) {
      if (NON_TERMINAL.has(o.status)) counts[o.knownAs] = (counts[o.knownAs] ?? 0) + 1;
    }
    return Promise.resolve({ ok: true, value: counts });
  }

  /** The parent columns for a move, read from the root or a stored org. */
  private parentFields(id: string): Pick<Organisation, 'parentId' | 'parentName'> {
    const parent = this.root?.id === id ? this.root : this.byId.get(id);
    return { parentId: id, parentName: parent?.displayName ?? null };
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

  /**
   * Runs `fn` after every earlier tree write has finished, as the Postgres tree lock does.
   *
   * @param fn - The tree write.
   * @returns What `fn` returns.
   */
  private withTreeLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.treeLock.then(fn, fn);
    this.treeLock = run.catch(() => undefined);
    return run;
  }

  /** The tree as the shared checks see it: the root and every stored org. */
  private treeSnapshot(): Tree {
    return buildTree(
      [...(this.root ? [this.root] : []), ...this.byId.values()].map((o) => ({
        id: o.id,
        parentId: o.parentId,
        depth: o.depth,
        status: o.status,
        isRoot: o === this.root,
        isDefault: o.isDefault,
        knownAs: o.knownAs,
      })),
    );
  }

  /**
   * Checks the limits for one more org under a parent.
   *
   * @param parentId - The parent id; `null` for a top-level org when no root is seeded.
   * @param parentDepth - The parent's depth.
   * @param rules - Tree limits.
   * @returns The refusal code, or `null` when the org fits.
   */
  private limitRefusal(parentId: string | null, parentDepth: number, rules: TreeRules) {
    const live = [...this.byId.values()].filter(counts);
    const children = live.filter((o) => o.parentId === parentId).length;
    return newChildRefusal(parentDepth, children, live.length, rules);
  }

  /**
   * Picks the parent for a new org, as Postgres does.
   *
   * @param requested - The requested parent id; the root when absent.
   * @returns The parent, or `null` when the request is not a valid parent (or no root is seeded).
   */
  private resolveParent(requested: string | undefined): Organisation | null {
    if (requested === undefined) return this.root;
    if (this.root?.id === requested) return this.root;
    const o = this.byId.get(requested);
    return o && o.status === 'active' && !o.isDefault ? o : null;
  }

  /** Ids of every org below `id`, at most {@link DESCENDANT_LEVEL_CAP} levels down. */
  private descendantIdsOf(id: string): Set<string> {
    const below = subtree(this.treeSnapshot(), id, DESCENDANT_LEVEL_CAP).slice(1);
    return new Set(below.map((n) => n.id));
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

function err<T>(
  code: Exclude<OrgStoreError['code'], 'KNOWN_AS_DEPTH'>,
  message: string,
): OrgStoreResult<T> {
  return { ok: false, error: { code, message } };
}

function knownAsDepth<T>(orgIds: string[]): OrgStoreResult<T> {
  return {
    ok: false,
    error: { code: 'KNOWN_AS_DEPTH', message: 'known_as not allowed at depth', orgIds },
  };
}

/** Orders orgs as Postgres does: lower(name), then id. */
function byName(a: Organisation, b: Organisation): number {
  const an = a.displayName.toLowerCase();
  const bn = b.displayName.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}
