import { describe, it, expect } from 'vitest';
import { InMemoryOrganisationStore } from '../memory.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  buildDefaultOrg,
  permissiveTreeRules,
} from '../testing.js';
import { NO_CONSENT_WRITE } from '../../consent-ledger/hook.js';
import type { CreateOrgInput, Organisation, TreeRules } from '../interface.js';

describe('InMemoryOrganisationStore', () => {
  it('creates and finds an org by slug and owner email', async () => {
    const store = new InMemoryOrganisationStore();
    const created = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'enable-india',
        displayName: 'Enable India',
        ownerEmail: 'owner@enable.org',
      },
      permissiveTreeRules(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const bySlug = await store.findBySlug('enable-india');
    expect(bySlug.ok && bySlug.value?.id).toBe(created.value.id);
    const byOwner = await store.findByOwnerEmail('owner@enable.org');
    expect(byOwner.ok && byOwner.value?.id).toBe(created.value.id);
    expect(created.value.status).toBe('pending');
  });

  it('lowercases owner email so lookups are case-insensitive', async () => {
    const store = new InMemoryOrganisationStore();
    await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 's',
        displayName: 'S',
        ownerEmail: 'Owner@Enable.ORG',
      },
      permissiveTreeRules(),
    );
    const byOwner = await store.findByOwnerEmail('owner@enable.org');
    expect(byOwner.ok && byOwner.value?.slug).toBe('s');
  });

  it('rejects a slug already taken by a non-terminal org with DUPLICATE_SLUG', async () => {
    const store = new InMemoryOrganisationStore();
    await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'dup',
        displayName: 'A',
        ownerEmail: 'a@x.org',
      },
      permissiveTreeRules(),
    );
    const second = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'dup',
        displayName: 'B',
        ownerEmail: 'b@x.org',
      },
      permissiveTreeRules(),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('DUPLICATE_SLUG');
  });

  it('allows a slug previously used only by a rejected org', async () => {
    const store = new InMemoryOrganisationStore();
    const first = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'reusable',
        displayName: 'A',
        ownerEmail: 'a@x.org',
      },
      permissiveTreeRules(),
    );
    if (first.ok) await store.reject(first.value.id, 'admin');
    const second = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'reusable',
        displayName: 'B',
        ownerEmail: 'b@x.org',
      },
      permissiveTreeRules(),
    );
    expect(second.ok).toBe(true);
  });

  it('listActive returns only active orgs, oldest first', async () => {
    const store = new InMemoryOrganisationStore();
    const a = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'a',
        displayName: 'A',
        ownerEmail: 'a@x.org',
      },
      permissiveTreeRules(),
    );
    await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'b',
        displayName: 'B',
        ownerEmail: 'b@x.org',
      },
      permissiveTreeRules(),
    );
    if (a.ok) await store.approve(a.value.id, 'admin');
    const active = await store.listActive();
    expect(active.ok && active.value.map((o) => o.slug)).toEqual(['a']);
  });

  it('approve is an atomic single-use guard (second approve returns null)', async () => {
    const store = new InMemoryOrganisationStore();
    const a = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'a',
        displayName: 'A',
        ownerEmail: 'a@x.org',
      },
      permissiveTreeRules(),
    );
    if (!a.ok) return;
    const first = await store.approve(a.value.id, 'admin');
    const second = await store.approve(a.value.id, 'admin');
    expect(first.ok && first.value?.status).toBe('active');
    expect(second.ok && second.value).toBeNull();
  });

  it('update patches fields and bumps updatedAt', async () => {
    const store = new InMemoryOrganisationStore();
    const a = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'a',
        displayName: 'A',
        ownerEmail: 'a@x.org',
      },
      permissiveTreeRules(),
    );
    if (!a.ok) return;
    const patched = await store.update(a.value.id, { kcGroupId: 'grp-1', ownerKcSub: 'kc-1' });
    expect(patched.ok && patched.value.kcGroupId).toBe('grp-1');
    expect(patched.ok && patched.value.ownerKcSub).toBe('kc-1');
  });

  it('reject stamps write-once rejected_at; approve leaves it null (#726)', async () => {
    const store = new InMemoryOrganisationStore();
    const rej = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'r',
        displayName: 'R',
        ownerEmail: 'r@x.org',
      },
      permissiveTreeRules(),
    );
    const app = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'p',
        displayName: 'P',
        ownerEmail: 'p@x.org',
      },
      permissiveTreeRules(),
    );
    if (!rej.ok || !app.ok) return;
    expect(rej.value.rejectedAt).toBeNull();

    const rejected = await store.reject(rej.value.id, 'admin');
    expect(rejected.ok && rejected.value?.status).toBe('inactive');
    expect(rejected.ok && rejected.value?.rejectedAt).toBeInstanceOf(Date);

    const approved = await store.approve(app.value.id, 'admin');
    expect(approved.ok && approved.value?.status).toBe('active');
    expect(approved.ok && approved.value?.rejectedAt).toBeNull();
  });

  it('update can revive a rejected org by clearing rejected_at (#726)', async () => {
    const store = new InMemoryOrganisationStore();
    const a = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'a',
        displayName: 'A',
        ownerEmail: 'a@x.org',
      },
      permissiveTreeRules(),
    );
    if (!a.ok) return;
    await store.reject(a.value.id, 'admin');
    const revived = await store.update(a.value.id, { status: 'pending', rejectedAt: null });
    expect(revived.ok && revived.value.status).toBe('pending');
    expect(revived.ok && revived.value.rejectedAt).toBeNull();
  });
});

describe('InMemoryOrganisationStore contact rules', () => {
  it('fails a non-canonical owner phone like the Postgres store (no row written)', async () => {
    const store = new InMemoryOrganisationStore();
    const r = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'bad-phone',
        displayName: 'Bad Phone',
        ownerEmail: 'o@x.org',
        ownerPhone: '98765',
      },
      permissiveTreeRules(),
    );
    expect(r.ok || r.error.code).toBe('DB_UNAVAILABLE');
    expect(await store.findBySlug('bad-phone')).toEqual({ ok: true, value: null });
  });

  it('finds an org by its owner phone', async () => {
    const store = new InMemoryOrganisationStore();
    const r = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'with-phone',
        displayName: 'With Phone',
        ownerEmail: 'o@x.org',
        ownerPhone: '+919876500001',
      },
      permissiveTreeRules(),
    );
    const found = await store.findByOwnerPhone('+919876500001');
    expect(found.ok && found.value?.id).toBe(r.ok && r.value.id);
  });

  it('returns NOT_FOUND from update / approve / reject for an unknown id', async () => {
    const store = new InMemoryOrganisationStore();
    const results = [
      await store.update('missing', { status: 'active' }),
      await store.approve('missing', 'admin'),
      await store.reject('missing', 'admin'),
    ];
    for (const r of results) expect(r.ok || r.error.code).toBe('NOT_FOUND');
  });
});

describe('InMemoryOrganisationStore owners (0027)', () => {
  it('gives one owner person one account across orgs, and reports sharing', async () => {
    const store = new InMemoryOrganisationStore();
    const a = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'a',
        displayName: 'A',
        ownerEmail: 'o@x.org',
        ownerPhone: '+919000000001',
      },
      permissiveTreeRules(),
    );
    const b = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'b',
        displayName: 'B',
        ownerEmail: 'o@x.org',
        ownerPhone: '+919000000001',
      },
      permissiveTreeRules(),
    );
    const c = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'c',
        displayName: 'C',
        ownerEmail: 'c@x.org',
        ownerPhone: '+919000000002',
      },
      permissiveTreeRules(),
    );
    if (!a.ok || !b.ok || !c.ok) throw new Error('seed');
    expect(a.value.ownerUserId).toBe(b.value.ownerUserId);
    expect(c.value.ownerUserId).not.toBe(a.value.ownerUserId);
    expect(await store.ownerIsShared(a.value.id)).toEqual({ ok: true, value: true });
    expect(await store.ownerIsShared(c.value.id)).toEqual({ ok: true, value: false });
  });

  it('resolves an owner lookup to the live org first, then the newest', async () => {
    const store = new InMemoryOrganisationStore();
    const old = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'old',
        displayName: 'Old',
        ownerEmail: 'o@x.org',
        ownerPhone: '+919000000001',
      },
      permissiveTreeRules(),
    );
    if (!old.ok) throw new Error('seed');
    await store.reject(old.value.id, 'admin');
    const fresh = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 'new',
        displayName: 'New',
        ownerEmail: 'o@x.org',
        ownerPhone: '+919000000001',
      },
      permissiveTreeRules(),
    );
    if (!fresh.ok) throw new Error('seed');
    const found = await store.findByOwnerEmail('O@X.org');
    expect(found.ok && found.value?.id).toBe(fresh.value.id);
  });
});

describe('organisations scoping (0028)', () => {
  it('lists active orgs by name, case-insensitively, Default included', async () => {
    const store = new OrganisationStoreFake();
    store.seed([
      buildOrganisation({ id: 'b', slug: 'b', displayName: 'beta', status: 'active' }),
      buildDefaultOrg(),
      buildOrganisation({ id: 'a', slug: 'a', displayName: 'Alpha', status: 'active' }),
    ]);
    const r = await store.listActive();
    expect(r.ok && r.value.map((o) => o.displayName)).toEqual(['Alpha', 'beta', 'Default']);
  });

  it('never resolves the Default org as an owner match', async () => {
    const store = new OrganisationStoreFake();
    store.seed([buildDefaultOrg({ ownerEmail: 'ops@x.org', ownerPhone: '+919000000001' })]);
    expect(await store.findByOwnerEmail('ops@x.org')).toEqual({ ok: true, value: null });
    expect(await store.findByOwnerPhone('+919000000001')).toEqual({ ok: true, value: null });
  });

  it('finds the Default org and the seeded root', async () => {
    const store = new OrganisationStoreFake();
    expect(await store.findRoot()).toEqual({ ok: true, value: null });
    store.seed([buildDefaultOrg()]);
    const root = buildOrganisation({ id: 'nf', slug: 'network', status: 'active' });
    store.seedRoot(root);
    const d = await store.findDefault();
    expect(d.ok && d.value?.isDefault).toBe(true);
    expect(await store.findRoot()).toEqual({ ok: true, value: root });
    // The root is never part of the aggregator list.
    const list = await store.listActive();
    expect(list.ok && list.value.map((o) => o.id)).toEqual([buildDefaultOrg().id]);
  });

  it('never deletes the Default org', async () => {
    const store = new OrganisationStoreFake();
    store.seed([buildDefaultOrg()]);
    await store.deleteById(buildDefaultOrg().id);
    const d = await store.findDefault();
    expect(d.ok && d.value).not.toBeNull();
  });

  it('carries url / locations from create', async () => {
    const store = new OrganisationStoreFake();
    const loc = [{ geo: { type: 'Point' as const, coordinates: [1, 2] }, address: {} }];
    const r = await store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: 's-1',
        displayName: 'S',
        ownerEmail: 's@x.org',
        url: 'https://s.example',
        locations: loc,
      },
      permissiveTreeRules(),
    );
    expect(r.ok && r.value.url).toBe('https://s.example');
    expect(r.ok && r.value.locations).toEqual(loc);
    expect(r.ok && r.value.isDefault).toBe(false);
  });
});

describe('InMemoryOrganisationStore — consent hook (0029)', () => {
  it('runs recordConsent with the new org id', async () => {
    const store = new InMemoryOrganisationStore();
    const seen: string[] = [];
    const created = await store.create(
      {
        slug: 'c1',
        displayName: 'C1',
        ownerEmail: 'c1@x.org',
        recordConsent: async (_tx, id) => {
          seen.push(id);
        },
      },
      permissiveTreeRules(),
    );
    expect(created.ok && [created.value.id]).toEqual(seen);
  });

  it('stores nothing and answers CONSENT_WRITE_FAILED when the hook throws', async () => {
    const store = new InMemoryOrganisationStore();
    const created = await store.create(
      {
        slug: 'c2',
        displayName: 'C2',
        ownerEmail: 'c2@x.org',
        recordConsent: async () => {
          throw new Error('ledger down');
        },
      },
      permissiveTreeRules(),
    );
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe('CONSENT_WRITE_FAILED');
    const found = await store.findBySlug('c2');
    expect(found.ok && found.value).toBeNull();
  });
});

describe('InMemoryOrganisationStore — listPending, search, delete and details', () => {
  const mk = (store: InMemoryOrganisationStore, slug: string, email: string, phone?: string) =>
    store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug,
        displayName: slug.toUpperCase(),
        ownerEmail: email,
        ...(phone ? { ownerPhone: phone } : {}),
      },
      permissiveTreeRules(),
    );

  it('markCoordinator makes a contact count as shared even without a second org', async () => {
    const store = new InMemoryOrganisationStore();
    const a = await mk(store, 'solo', 'solo@x.org', '+919000000041');
    if (!a.ok) throw new Error('seed');
    expect(await store.ownerIsShared(a.value.id)).toEqual({ ok: true, value: false });
    store.markCoordinator(a.value.contactId);
    expect(await store.ownerIsShared(a.value.id)).toEqual({ ok: true, value: true });
  });

  it('listPending filters by updatedBefore and orders oldest first', async () => {
    const store = new OrganisationStoreFake();
    store.seed([
      buildOrganisation({
        id: 'p1',
        slug: 'p1',
        status: 'pending',
        createdAt: new Date(1000),
        updatedAt: new Date(1000),
      }),
      buildOrganisation({
        id: 'p2',
        slug: 'p2',
        status: 'pending',
        createdAt: new Date(2000),
        updatedAt: new Date(5000),
      }),
    ]);
    const all = await store.listPending();
    expect(all.ok && all.value.map((o) => o.id)).toEqual(['p1', 'p2']);
    const stale = await store.listPending(new Date(3000));
    expect(stale.ok && stale.value.map((o) => o.id)).toEqual(['p1']);
  });

  it('deleteById releases the owner account once it owns no other org', async () => {
    const store = new InMemoryOrganisationStore();
    const a = await mk(store, 'only', 'only@x.org', '+919000000042');
    if (!a.ok) throw new Error('seed');
    await store.deleteById(a.value.id);
    // A fresh create by the same owner mints a new account id (the old was released).
    const b = await mk(store, 'again', 'only@x.org', '+919000000042');
    expect(b.ok && b.value.ownerUserId).not.toBe(a.value.ownerUserId);
  });

  it('search scopes by orgIds, status and name prefix, and pages with a cursor', async () => {
    const store = new OrganisationStoreFake();
    store.seed([
      buildOrganisation({ id: 'a', slug: 'a', displayName: 'Alpha', status: 'active' }),
      buildOrganisation({ id: 'b', slug: 'b', displayName: 'Beta', status: 'active' }),
      buildOrganisation({ id: 'c', slug: 'c', displayName: 'Gamma', status: 'pending' }),
    ]);
    const scoped = await store.search({ orgIds: ['a', 'b'], limit: 20 });
    expect(scoped.ok && scoped.value.rows.map((o) => o.id)).toEqual(['a', 'b']);
    const byStatus = await store.search({ orgIds: null, status: 'pending', limit: 20 });
    expect(byStatus.ok && byStatus.value.rows.map((o) => o.id)).toEqual(['c']);
    const byName = await store.search({ orgIds: null, namePrefix: 'be', limit: 20 });
    expect(byName.ok && byName.value.rows.map((o) => o.id)).toEqual(['b']);

    const page1 = await store.search({ orgIds: null, limit: 1 });
    expect(page1.ok && page1.value.rows.map((o) => o.id)).toEqual(['a']);
    expect(page1.ok && page1.value.nextCursor).not.toBeNull();
    if (page1.ok && page1.value.nextCursor) {
      const page2 = await store.search({ orgIds: null, limit: 1, cursor: page1.value.nextCursor });
      expect(page2.ok && page2.value.rows.map((o) => o.id)).toEqual(['b']);
    }
  });

  it('search filters by known_as', async () => {
    const store = new OrganisationStoreFake();
    store.seed([
      buildOrganisation({ id: 'a', slug: 'a', displayName: 'Alpha' }),
      buildOrganisation({ id: 'b', slug: 'b', displayName: 'Beta', knownAs: 'district' }),
    ]);
    const r = await store.search({ orgIds: null, knownAs: 'district', limit: 20 });
    expect(r.ok && r.value.rows.map((o) => o.id)).toEqual(['b']);
    const none = await store.search({ orgIds: null, knownAs: 'ngo', limit: 20 });
    expect(none.ok && none.value.rows).toEqual([]);
  });

  it('create defaults known_as to aggregator', async () => {
    const store = new InMemoryOrganisationStore();
    const plain = await mk(store, 'ka1', 'ka1@x.org');
    expect(plain.ok && plain.value.knownAs).toBe('aggregator');
  });

  it('descendantIds lists every org below the given ones, at any depth, without them', async () => {
    const store = new OrganisationStoreFake();
    store.seed([
      buildOrganisation({ id: 's', slug: 's' }),
      buildOrganisation({ id: 'd', slug: 'd', parentId: 's' }),
      buildOrganisation({ id: 'a', slug: 'a', parentId: 'd', status: 'pending' }),
      buildOrganisation({ id: 'x', slug: 'x' }),
      buildOrganisation({ id: 'y', slug: 'y', parentId: 'x' }),
    ]);
    const r = await store.descendantIds(['s']);
    expect(r.ok && [...r.value].sort()).toEqual(['a', 'd']);
    const both = await store.descendantIds(['s', 'd']);
    expect(both.ok && both.value).toEqual(['a']);
    expect(await store.descendantIds([])).toEqual({ ok: true, value: [] });
  });

  it('countByKnownAs counts pending and active orgs per key', async () => {
    const store = new OrganisationStoreFake();
    store.seed([
      buildOrganisation({ id: 'a', slug: 'a', knownAs: 'state', status: 'active' }),
      buildOrganisation({ id: 'b', slug: 'b', knownAs: 'state', status: 'pending' }),
      buildOrganisation({ id: 'c', slug: 'c', knownAs: 'district', status: 'active' }),
      buildOrganisation({ id: 'd', slug: 'd', knownAs: 'district', status: 'inactive' }),
    ]);
    const r = await store.countByKnownAs();
    expect(r.ok && r.value).toEqual({ state: 2, district: 1 });
  });

  it('search breaks a same-name tie by id', async () => {
    const store = new OrganisationStoreFake();
    store.seed([
      buildOrganisation({ id: 'id-2', slug: 's2', displayName: 'Same', status: 'active' }),
      buildOrganisation({ id: 'id-1', slug: 's1', displayName: 'same', status: 'active' }),
    ]);
    const r = await store.search({ orgIds: null, limit: 20 });
    expect(r.ok && r.value.rows.map((o) => o.id)).toEqual(['id-1', 'id-2']);
  });

  it("listOwnedBy returns an owner's orgs by name", async () => {
    const store = new OrganisationStoreFake();
    store.seed([
      buildOrganisation({ id: 'o1', slug: 'o1', displayName: 'Zeta', ownerUserId: 'owner-1' }),
      buildOrganisation({ id: 'o2', slug: 'o2', displayName: 'Acme', ownerUserId: 'owner-1' }),
      buildOrganisation({ id: 'o3', slug: 'o3', displayName: 'Other', ownerUserId: 'owner-2' }),
    ]);
    const r = await store.listOwnedBy('owner-1');
    expect(r.ok && r.value.map((o) => o.displayName)).toEqual(['Acme', 'Zeta']);
  });

  it('update patches org-detail columns in place', async () => {
    const store = new InMemoryOrganisationStore();
    const a = await mk(store, 'det', 'det@x.org', '+919000000043');
    if (!a.ok) throw new Error('seed');
    const u = await store.update(a.value.id, {
      url: 'https://det.example',
      legalName: 'Det Ltd',
      gstNumber: 'GST123',
      state: 'KA',
      locations: [{ geo: { type: 'Point', coordinates: [1, 2] }, address: {} }],
    });
    expect(u.ok && u.value.url).toBe('https://det.example');
    expect(u.ok && u.value.legalName).toBe('Det Ltd');
    expect(u.ok && u.value.gstNumber).toBe('GST123');
    expect(u.ok && u.value.state).toBe('KA');
  });

  it('deleteIfPending deletes a stale pending org, aborts on a false hook, skips a decided org', async () => {
    const store = new InMemoryOrganisationStore();
    const a = await mk(store, 'del', 'del@x.org', '+919000000044');
    const b = await mk(store, 'keep', 'keep@x.org', '+919000000045');
    const c = await mk(store, 'abort', 'abort@x.org', '+919000000046');
    if (!a.ok || !b.ok || !c.ok) throw new Error('seed');
    const future = new Date(Date.now() + 3600_000);
    expect((await store.deleteIfPending(a.value.id, future, async () => true)).ok).toBe(true);
    expect(await store.findById(a.value.id)).toEqual({ ok: true, value: null });

    await store.approve(b.value.id, 't');
    const kept = await store.deleteIfPending(b.value.id, future, async () => true);
    expect(kept.ok && kept.value).toBe('not_pending');

    const aborted = await store.deleteIfPending(c.value.id, future, async () => false);
    expect(aborted.ok && aborted.value).toBe('aborted');
    const stillThere = await store.findById(c.value.id);
    expect(stillThere.ok && stillThere.value).not.toBeNull();
  });
});

describe('InMemoryOrganisationStore — parents and descendants', () => {
  const root = buildOrganisation({
    id: 'root',
    slug: 'network',
    displayName: 'Network',
    status: 'active',
    depth: 0,
  });
  const create = (store: InMemoryOrganisationStore, slug: string, parentId?: string) =>
    store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug,
        displayName: slug.toUpperCase(),
        ownerEmail: `${slug}@x.org`,
        ...(parentId === undefined ? {} : { parentId }),
      },
      permissiveTreeRules(),
    );

  it('create puts an org under the root when no parent is given', async () => {
    const store = new OrganisationStoreFake();
    store.seedRoot(root);
    const r = await create(store, 'top');
    expect(r.ok && [r.value.parentId, r.value.parentName]).toEqual(['root', 'Network']);
  });

  it('create sets depth to the parent depth plus one', async () => {
    const store = new OrganisationStoreFake();
    store.seedRoot(root);
    store.seed([buildOrganisation({ id: 'p', slug: 'p', status: 'active', depth: 1 })]);
    const top = await create(store, 'top');
    expect(top.ok && top.value.depth).toBe(1);
    const child = await create(store, 'child', 'p');
    expect(child.ok && child.value.depth).toBe(2);
  });

  it.each([
    ['unknown', 'missing'],
    ['pending', 'pending'],
    ['inactive', 'inactive'],
    ['Default', 'd0'],
  ])('create refuses a %s parent with INVALID_PARENT and stores nothing', async (_l, parentId) => {
    const store = new OrganisationStoreFake();
    store.seedRoot(root);
    store.seed([
      buildOrganisation({ id: 'pending', slug: 'p', status: 'pending' }),
      buildOrganisation({ id: 'inactive', slug: 'i', status: 'inactive' }),
      buildDefaultOrg({ id: 'd0' }),
    ]);
    const r = await create(store, 'child', parentId);
    expect(!r.ok && r.error.code).toBe('INVALID_PARENT');
    const found = await store.findBySlug('child');
    expect(found.ok && found.value).toBeNull();
  });

  it('search descendantsOf returns every org below, at any depth, and nothing else', async () => {
    const store = new OrganisationStoreFake();
    store.seed([
      buildOrganisation({ id: 's', slug: 's', displayName: 'State', parentId: 'root' }),
      buildOrganisation({ id: 'd', slug: 'd', displayName: 'District', parentId: 's' }),
      buildOrganisation({ id: 'a', slug: 'a', displayName: 'Agg', parentId: 'd' }),
      buildOrganisation({ id: 'x', slug: 'x', displayName: 'Other', parentId: 'root' }),
    ]);
    const fromState = await store.search({ orgIds: null, descendantsOf: 's' });
    expect(fromState.ok && fromState.value.rows.map((o) => o.id)).toEqual(['a', 'd']);
    const fromDistrict = await store.search({ orgIds: null, descendantsOf: 'd' });
    expect(fromDistrict.ok && fromDistrict.value.rows.map((o) => o.id)).toEqual(['a']);
    const leaf = await store.search({ orgIds: null, descendantsOf: 'a' });
    expect(leaf.ok && leaf.value.rows).toEqual([]);
    const withStatus = await store.search({ orgIds: null, descendantsOf: 's', status: 'active' });
    expect(withStatus.ok && withStatus.value.rows).toEqual([]);
  });
});

describe('InMemoryOrganisationStore — tree rules', () => {
  const rules = (over: Partial<TreeRules> = {}): TreeRules => ({
    maxDepth: 3,
    maxChildren: null,
    maxTotalOrgs: 50,
    knownAsAllowed: () => true,
    suggestFor: (depth) => `suggest-${depth}`,
    ...over,
  });
  const org = (id: string, parentId: string, depth: number, over: Partial<Organisation> = {}) =>
    buildOrganisation({
      id,
      slug: id,
      displayName: id.toUpperCase(),
      ownerEmail: `${id}@x.org`,
      status: 'active',
      parentId,
      depth,
      ...over,
    });
  /** root → A → B, root → C, root → Default. */
  const tree = (): OrganisationStoreFake => {
    const store = new OrganisationStoreFake();
    store.seedRoot(
      buildOrganisation({ id: 'root', slug: 'network', displayName: 'Network', depth: 0 }),
    );
    store.seed([
      buildDefaultOrg({ id: 'd0', parentId: 'root', depth: 1 }),
      org('a', 'root', 1),
      org('b', 'a', 2),
      org('c', 'root', 1),
    ]);
    return store;
  };
  const create = (
    store: InMemoryOrganisationStore,
    slug: string,
    r: TreeRules,
    parentId?: string,
  ) =>
    store.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug,
        displayName: slug.toUpperCase(),
        ownerEmail: `${slug}@x.org`,
        ...(parentId === undefined ? {} : { parentId }),
      },
      r,
    );
  const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);

  describe('create', () => {
    it('sets depth from a nested parent and the suggested known_as for that depth', async () => {
      const store = tree();
      const r = await create(store, 'new', rules(), 'b');
      expect(r.ok && [r.value.depth, r.value.knownAs, r.value.parentId]).toEqual([
        3,
        'suggest-3',
        'b',
      ]);
    });

    it('refuses an invalid parent with INVALID_PARENT', async () => {
      const store = tree();
      expect(code(await create(store, 'n', rules(), 'd0'))).toBe('INVALID_PARENT');
    });

    it('refuses a parent at max depth with DEPTH_LIMIT and stores nothing', async () => {
      const store = tree();
      expect(code(await create(store, 'n', rules({ maxDepth: 2 }), 'b'))).toBe('DEPTH_LIMIT');
      const found = await store.findBySlug('n');
      expect(found.ok && found.value).toBeNull();
    });

    it('refuses a full parent with CHILD_LIMIT; the Default org does not count', async () => {
      const store = tree();
      // The root holds a, c and Default: two counted children.
      expect(code(await create(store, 'n', rules({ maxChildren: 2 })))).toBe('CHILD_LIMIT');
      expect(code(await create(store, 'n', rules({ maxChildren: 3 })))).toBe('ok');
    });

    it('counts pending children; a rejected child does not count', async () => {
      const store = tree();
      store.seed([
        org('p', 'c', 2, { status: 'pending' }),
        org('x', 'c', 2, { status: 'inactive' }),
      ]);
      expect(code(await create(store, 'n', rules({ maxChildren: 1 }), 'c'))).toBe('CHILD_LIMIT');
      expect(code(await create(store, 'n', rules({ maxChildren: 2 }), 'c'))).toBe('ok');
    });

    it('refuses with TOTAL_LIMIT; Default and rejected orgs do not count, pending ones do', async () => {
      const store = tree();
      store.seed([
        org('p', 'root', 1, { status: 'pending' }),
        org('x', 'root', 1, { status: 'inactive' }),
      ]);
      // a, b, c, p count.
      expect(code(await create(store, 'n', rules({ maxTotalOrgs: 4 })))).toBe('TOTAL_LIMIT');
      expect(code(await create(store, 'n', rules({ maxTotalOrgs: 5 })))).toBe('ok');
    });

    it('lets one of two racing creates take the last child slot', async () => {
      const store = tree();
      const slow: CreateOrgInput['recordConsent'] = () => new Promise((r) => setTimeout(r, 5));
      const make = (slug: string) =>
        store.create(
          {
            recordConsent: slow,
            slug,
            displayName: slug,
            ownerEmail: `${slug}@x.org`,
            parentId: 'c',
          },
          rules({ maxChildren: 1 }),
        );
      const results = await Promise.all([make('r1'), make('r2')]);
      expect(results.map(code).sort()).toEqual(['CHILD_LIMIT', 'ok']);
    });
  });

  describe('revive', () => {
    it('sets a rejected org back to pending and clears rejected_at', async () => {
      const store = tree();
      store.seed([org('x', 'c', 2, { status: 'inactive', rejectedAt: new Date() })]);
      const r = await store.revive('x', 'c', rules());
      expect(r.ok && [r.value.status, r.value.rejectedAt]).toEqual(['pending', null]);
    });

    it('revives under the submitted parent and sets parent and depth from it', async () => {
      const store = tree();
      store.seed([org('x', 'c', 2, { status: 'inactive' })]);
      const r = await store.revive('x', 'b', rules());
      expect(r.ok && [r.value.parentId, r.value.parentName, r.value.depth]).toEqual(['b', 'B', 3]);
    });

    it('revives under the root when no parent is submitted', async () => {
      const store = tree();
      store.seed([org('x', 'b', 3, { status: 'inactive' })]);
      const r = await store.revive('x', undefined, rules());
      expect(r.ok && [r.value.parentId, r.value.depth]).toEqual(['root', 1]);
    });

    it('revives under a valid new parent when the stored parent is no longer active', async () => {
      const store = tree();
      store.seed([
        org('p', 'root', 1, { status: 'inactive' }),
        org('x', 'p', 2, { status: 'inactive' }),
      ]);
      const r = await store.revive('x', 'a', rules());
      expect(r.ok && [r.value.parentId, r.value.depth]).toEqual(['a', 2]);
    });

    it('keeps known_as when allowed at the new depth and suggests one when not', async () => {
      const store = tree();
      const atTwo = rules({ knownAsAllowed: (key, depth) => key !== 'block' || depth === 2 });
      store.seed([
        org('x', 'c', 2, { status: 'inactive', knownAs: 'block' }),
        org('y', 'c', 2, { status: 'inactive', knownAs: 'block' }),
      ]);
      const kept = await store.revive('x', 'a', atTwo);
      expect(kept.ok && kept.value.knownAs).toBe('block');
      const suggested = await store.revive('y', 'b', atTwo);
      expect(suggested.ok && [suggested.value.depth, suggested.value.knownAs]).toEqual([
        3,
        'suggest-3',
      ]);
    });

    it.each([
      ['CHILD_LIMIT', rules({ maxChildren: 1 }), 'c'],
      ['TOTAL_LIMIT', rules({ maxTotalOrgs: 4 }), 'c'],
      ['DEPTH_LIMIT', rules({ maxDepth: 2 }), 'b'],
      ['INVALID_PARENT', rules(), 'd0'],
    ] as const)('refuses with %s and leaves the org rejected', async (expected, r, parentId) => {
      const store = tree();
      store.seed([org('y', 'c', 2), org('x', 'a', 2, { status: 'inactive' })]);
      expect(code(await store.revive('x', parentId, r))).toBe(expected);
      const found = await store.findById('x');
      expect(found.ok && [found.value?.status, found.value?.parentId]).toEqual(['inactive', 'a']);
    });

    it('refuses with NOT_MOVABLE when the rejected org has child orgs', async () => {
      const store = tree();
      store.seed([org('x', 'c', 2, { status: 'inactive' }), org('z', 'x', 3)]);
      expect(code(await store.revive('x', 'a', rules()))).toBe('NOT_MOVABLE');
    });

    it('answers NOT_FOUND for an unknown or not rejected org', async () => {
      const store = tree();
      expect(code(await store.revive('missing', undefined, rules()))).toBe('NOT_FOUND');
      expect(code(await store.revive('a', undefined, rules()))).toBe('NOT_FOUND');
    });
  });

  describe('move', () => {
    it('moves an org and shifts the depth of its subtree', async () => {
      const store = tree();
      const r = await store.move('a', { parentId: 'c' }, rules());
      expect(r.ok && [r.value.movedCount, r.value.org.parentId, r.value.org.parentName]).toEqual([
        2,
        'c',
        'C',
      ]);
      const a = await store.findById('a');
      const b = await store.findById('b');
      expect([a.ok && a.value?.depth, b.ok && b.value?.depth]).toEqual([2, 3]);
    });

    it('returns the parent the org had before the move', async () => {
      const store = tree();
      const r = await store.move('b', { parentId: 'c' }, rules());
      expect(r.ok && r.value.oldParentId).toBe('a');
    });

    it('moves the whole subtree, however deep', async () => {
      const store = tree();
      const chain = Array.from({ length: 40 }, (_v, i) =>
        org(`n${i}`, i === 0 ? 'c' : `n${i - 1}`, i + 2),
      );
      store.seed(chain);
      const r = await store.move('c', { parentId: 'a' }, rules({ maxDepth: 100 }));
      expect(r.ok && r.value.movedCount).toBe(41);
      const last = await store.findById('n39');
      expect(last.ok && last.value?.depth).toBe(42);
    });

    it('moves an org back under the root', async () => {
      const store = tree();
      const r = await store.move('b', { parentId: 'root' }, rules());
      expect(r.ok && [r.value.org.depth, r.value.org.parentName]).toEqual([1, 'Network']);
    });

    it.each([
      ['PARENT_CYCLE', 'a', 'b'],
      ['PARENT_CYCLE', 'a', 'a'],
      ['INVALID_PARENT', 'a', 'd0'],
      ['INVALID_PARENT', 'a', 'missing'],
      ['NOT_MOVABLE', 'd0', 'c'],
      ['NOT_MOVABLE', 'root', 'c'],
      ['NOT_FOUND', 'missing', 'c'],
    ])('refuses with %s (move %s under %s)', async (expected, id, parentId) => {
      const store = tree();
      expect(code(await store.move(id, { parentId }, rules()))).toBe(expected);
    });

    it('refuses a rejected org with NOT_MOVABLE and a pending parent with INVALID_PARENT', async () => {
      const store = tree();
      store.seed([
        org('x', 'root', 1, { status: 'inactive' }),
        org('p', 'root', 1, { status: 'pending' }),
      ]);
      expect(code(await store.move('x', { parentId: 'c' }, rules()))).toBe('NOT_MOVABLE');
      expect(code(await store.move('c', { parentId: 'p' }, rules()))).toBe('INVALID_PARENT');
    });

    it('counts the height of the subtree against max depth', async () => {
      const store = tree();
      // a at depth 2 puts b at depth 3.
      expect(code(await store.move('a', { parentId: 'c' }, rules({ maxDepth: 2 })))).toBe(
        'DEPTH_LIMIT',
      );
      expect(code(await store.move('b', { parentId: 'c' }, rules({ maxDepth: 2 })))).toBe('ok');
    });

    it('refuses a full new parent with CHILD_LIMIT', async () => {
      const store = tree();
      store.seed([org('y', 'c', 2)]);
      expect(code(await store.move('b', { parentId: 'c' }, rules({ maxChildren: 1 })))).toBe(
        'CHILD_LIMIT',
      );
    });

    it('refuses with KNOWN_AS_DEPTH naming the descendants and leaves the tree unchanged', async () => {
      const store = tree();
      store.seed([org('b', 'a', 2, { knownAs: 'district' })]);
      const r = await store.move(
        'a',
        { parentId: 'c' },
        rules({ knownAsAllowed: (k, d) => k !== 'district' || d === 2 }),
      );
      expect(!r.ok && r.error).toMatchObject({ code: 'KNOWN_AS_DEPTH', orgIds: ['b'] });
      const a = await store.findById('a');
      const b = await store.findById('b');
      expect([a.ok && a.value?.parentId, a.ok && a.value?.depth, b.ok && b.value?.depth]).toEqual([
        'root',
        1,
        2,
      ]);
    });

    it('checks a new known_as for the moved org at its new depth', async () => {
      const store = tree();
      const only1 = rules({ knownAsAllowed: (k, d) => k !== 'state' || d === 1 });
      const bad = await store.move('c', { parentId: 'a', knownAs: 'state' }, only1);
      expect(!bad.ok && bad.error).toMatchObject({ code: 'KNOWN_AS_DEPTH', orgIds: ['c'] });
      const good = await store.move('b', { parentId: 'root', knownAs: 'state' }, only1);
      expect(good.ok && [good.value.org.knownAs, good.value.org.depth]).toEqual(['state', 1]);
    });

    it('is a no-op for the current parent; with known_as it changes only the value', async () => {
      const store = tree();
      const same = await store.move('b', { parentId: 'a' }, rules());
      expect(same.ok && [same.value.movedCount, same.value.org.knownAs]).toEqual([0, 'aggregator']);
      const named = await store.move('b', { parentId: 'a', knownAs: 'district' }, rules());
      expect(
        named.ok && [named.value.movedCount, named.value.org.knownAs, named.value.org.depth],
      ).toEqual([0, 'district', 2]);
      const refused = await store.move(
        'b',
        { parentId: 'a', knownAs: 'state' },
        rules({ knownAsAllowed: (k) => k !== 'state' }),
      );
      expect(!refused.ok && refused.error).toMatchObject({ code: 'KNOWN_AS_DEPTH', orgIds: ['b'] });
    });
  });

  describe('update with known_as', () => {
    it('sets a value allowed at the stored depth with the other fields', async () => {
      const store = tree();
      const r = await store.update('b', { displayName: 'B2', knownAs: 'district' }, rules());
      expect(r.ok && [r.value.displayName, r.value.knownAs]).toEqual(['B2', 'district']);
    });

    it('refuses a value not allowed at the stored depth and saves no other field', async () => {
      const store = tree();
      const before = await store.findById('b');
      const r = await store.update(
        'b',
        { displayName: 'B2', knownAs: 'state' },
        rules({ knownAsAllowed: (_k, d) => d === 1 }),
      );
      expect(!r.ok && r.error).toMatchObject({ code: 'KNOWN_AS_DEPTH', orgIds: ['b'] });
      const after = await store.findById('b');
      expect(after).toEqual(before);
    });

    it('answers NOT_FOUND for an unknown org', async () => {
      expect(code(await tree().update('missing', { knownAs: 'x' }, rules()))).toBe('NOT_FOUND');
    });
  });

  describe('parentOptions', () => {
    it('lists the root and every other org with the result a move would give', async () => {
      const store = tree();
      store.seed([
        org('p', 'root', 1, { status: 'pending' }),
        org('full', 'root', 1),
        org('f1', 'full', 2),
        org('deep', 'b', 3),
      ]);
      const r = await store.parentOptions('a', rules({ maxChildren: 1 }));
      if (!r.ok) throw new Error(r.error.code);
      // a, b and deep move together.
      expect(r.value.subtreeSize).toBe(3);
      const reasons = Object.fromEntries(
        r.value.options.map((o) => [o.org.id, o.ok ? 'ok' : o.reason]),
      );
      expect(reasons).toEqual({
        root: 'ok',
        b: 'PARENT_CYCLE',
        deep: 'PARENT_CYCLE',
        c: 'DEPTH_LIMIT',
        d0: 'INVALID_PARENT',
        p: 'INVALID_PARENT',
        full: 'CHILD_LIMIT',
        f1: 'DEPTH_LIMIT',
      });
    });

    it('refuses with KNOWN_AS_DEPTH a parent that puts an org below at a depth its value does not allow', async () => {
      const store = tree();
      store.seed([
        org('a', 'root', 1, { knownAs: 'state' }),
        org('b', 'a', 2, { knownAs: 'district' }),
        org('e', 'root', 1, { knownAs: 'state' }),
      ]);
      // state only at depth 1, district only at depth 2.
      const r = rules({
        knownAsAllowed: (k, d) => (k === 'state' ? d === 1 : k !== 'district' || d === 2),
      });
      const reasonsOf = async (id: string) => {
        const res = await store.parentOptions(id, r);
        if (!res.ok) throw new Error(res.error.code);
        return Object.fromEntries(res.value.options.map((o) => [o.org.id, o.ok ? 'ok' : o.reason]));
      };
      // b would sit at depth 3.
      expect(await reasonsOf('a')).toMatchObject({ root: 'ok', c: 'KNOWN_AS_DEPTH' });
      // The moved org's own value is not checked: the move can change it.
      expect(await reasonsOf('e')).toMatchObject({ root: 'ok', c: 'ok' });
    });

    it('answers NOT_FOUND for an unknown org', async () => {
      expect(code(await tree().parentOptions('missing', rules()))).toBe('NOT_FOUND');
    });
  });

  describe('counts', () => {
    it('childCounts counts pending and active children, Default and rejected excluded', async () => {
      const store = tree();
      store.seed([
        org('p', 'c', 2, { status: 'pending' }),
        org('x', 'c', 2, { status: 'inactive' }),
      ]);
      const r = await store.childCounts(['root', 'a', 'b', 'c']);
      expect(r).toEqual({ ok: true, value: { root: 2, a: 1, b: 0, c: 1 } });
    });

    it('countTotal counts pending and active orgs, Default and rejected excluded', async () => {
      const store = tree();
      store.seed([
        org('p', 'c', 2, { status: 'pending' }),
        org('x', 'c', 2, { status: 'inactive' }),
      ]);
      expect(await store.countTotal()).toEqual({ ok: true, value: 4 });
    });
  });

  it('descendantIds stops 32 levels down', async () => {
    const store = tree();
    const chain = Array.from({ length: 40 }, (_v, i) =>
      org(`n${i}`, i === 0 ? 'c' : `n${i - 1}`, i + 2),
    );
    store.seed(chain);
    const r = await store.descendantIds(['c']);
    expect(r.ok && r.value.length).toBe(32);
  });
});
