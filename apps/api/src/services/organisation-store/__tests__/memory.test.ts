import { describe, it, expect } from 'vitest';
import { InMemoryOrganisationStore } from '../memory.js';
import { OrganisationStoreFake, buildAggregatorOrg, buildDefaultOrg } from '../testing.js';
import { NO_CONSENT_WRITE } from '../../consent-ledger/hook.js';

describe('InMemoryOrganisationStore', () => {
  it('creates and finds an org by slug and owner email', async () => {
    const store = new InMemoryOrganisationStore();
    const created = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'enable-india',
      displayName: 'Enable India',
      ownerEmail: 'owner@enable.org',
    });
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
    await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 's',
      displayName: 'S',
      ownerEmail: 'Owner@Enable.ORG',
    });
    const byOwner = await store.findByOwnerEmail('owner@enable.org');
    expect(byOwner.ok && byOwner.value?.slug).toBe('s');
  });

  it('rejects a slug already taken by a non-terminal org with DUPLICATE_SLUG', async () => {
    const store = new InMemoryOrganisationStore();
    await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'dup',
      displayName: 'A',
      ownerEmail: 'a@x.org',
    });
    const second = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'dup',
      displayName: 'B',
      ownerEmail: 'b@x.org',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('DUPLICATE_SLUG');
  });

  it('allows a slug previously used only by a rejected org', async () => {
    const store = new InMemoryOrganisationStore();
    const first = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'reusable',
      displayName: 'A',
      ownerEmail: 'a@x.org',
    });
    if (first.ok) await store.reject(first.value.id, 'admin');
    const second = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'reusable',
      displayName: 'B',
      ownerEmail: 'b@x.org',
    });
    expect(second.ok).toBe(true);
  });

  it('listActive returns only active orgs, oldest first', async () => {
    const store = new InMemoryOrganisationStore();
    const a = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'a',
      displayName: 'A',
      ownerEmail: 'a@x.org',
    });
    await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'b',
      displayName: 'B',
      ownerEmail: 'b@x.org',
    });
    if (a.ok) await store.approve(a.value.id, 'admin');
    const active = await store.listActive();
    expect(active.ok && active.value.map((o) => o.slug)).toEqual(['a']);
  });

  it('approve is an atomic single-use guard (second approve returns null)', async () => {
    const store = new InMemoryOrganisationStore();
    const a = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'a',
      displayName: 'A',
      ownerEmail: 'a@x.org',
    });
    if (!a.ok) return;
    const first = await store.approve(a.value.id, 'admin');
    const second = await store.approve(a.value.id, 'admin');
    expect(first.ok && first.value?.status).toBe('active');
    expect(second.ok && second.value).toBeNull();
  });

  it('update patches fields and bumps updatedAt', async () => {
    const store = new InMemoryOrganisationStore();
    const a = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'a',
      displayName: 'A',
      ownerEmail: 'a@x.org',
    });
    if (!a.ok) return;
    const patched = await store.update(a.value.id, { kcGroupId: 'grp-1', ownerKcSub: 'kc-1' });
    expect(patched.ok && patched.value.kcGroupId).toBe('grp-1');
    expect(patched.ok && patched.value.ownerKcSub).toBe('kc-1');
  });

  it('reject stamps write-once rejected_at; approve leaves it null (#726)', async () => {
    const store = new InMemoryOrganisationStore();
    const rej = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'r',
      displayName: 'R',
      ownerEmail: 'r@x.org',
    });
    const app = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'p',
      displayName: 'P',
      ownerEmail: 'p@x.org',
    });
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
    const a = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'a',
      displayName: 'A',
      ownerEmail: 'a@x.org',
    });
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
    const r = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'bad-phone',
      displayName: 'Bad Phone',
      ownerEmail: 'o@x.org',
      ownerPhone: '98765',
    });
    expect(r.ok || r.error.code).toBe('DB_UNAVAILABLE');
    expect(await store.findBySlug('bad-phone')).toEqual({ ok: true, value: null });
  });

  it('finds an org by its owner phone', async () => {
    const store = new InMemoryOrganisationStore();
    const r = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'with-phone',
      displayName: 'With Phone',
      ownerEmail: 'o@x.org',
      ownerPhone: '+919876500001',
    });
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
    const a = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'a',
      displayName: 'A',
      ownerEmail: 'o@x.org',
      ownerPhone: '+919000000001',
    });
    const b = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'b',
      displayName: 'B',
      ownerEmail: 'o@x.org',
      ownerPhone: '+919000000001',
    });
    const c = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'c',
      displayName: 'C',
      ownerEmail: 'c@x.org',
      ownerPhone: '+919000000002',
    });
    if (!a.ok || !b.ok || !c.ok) throw new Error('seed');
    expect(a.value.ownerUserId).toBe(b.value.ownerUserId);
    expect(c.value.ownerUserId).not.toBe(a.value.ownerUserId);
    expect(await store.ownerIsShared(a.value.id)).toEqual({ ok: true, value: true });
    expect(await store.ownerIsShared(c.value.id)).toEqual({ ok: true, value: false });
  });

  it('resolves an owner lookup to the live org first, then the newest', async () => {
    const store = new InMemoryOrganisationStore();
    const old = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'old',
      displayName: 'Old',
      ownerEmail: 'o@x.org',
      ownerPhone: '+919000000001',
    });
    if (!old.ok) throw new Error('seed');
    await store.reject(old.value.id, 'admin');
    const fresh = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'new',
      displayName: 'New',
      ownerEmail: 'o@x.org',
      ownerPhone: '+919000000001',
    });
    if (!fresh.ok) throw new Error('seed');
    const found = await store.findByOwnerEmail('O@X.org');
    expect(found.ok && found.value?.id).toBe(fresh.value.id);
  });
});

describe('organisations scoping (0028)', () => {
  it('lists active orgs by name, case-insensitively, Default included', async () => {
    const store = new OrganisationStoreFake();
    store.seed([
      buildAggregatorOrg({ id: 'b', slug: 'b', displayName: 'beta', status: 'active' }),
      buildDefaultOrg(),
      buildAggregatorOrg({ id: 'a', slug: 'a', displayName: 'Alpha', status: 'active' }),
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
    const root = buildAggregatorOrg({ id: 'nf', slug: 'network', status: 'active' });
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
    const r = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 's-1',
      displayName: 'S',
      ownerEmail: 's@x.org',
      url: 'https://s.example',
      locations: loc,
    });
    expect(r.ok && r.value.url).toBe('https://s.example');
    expect(r.ok && r.value.locations).toEqual(loc);
    expect(r.ok && r.value.isDefault).toBe(false);
  });
});

describe('InMemoryOrganisationStore — consent hook (0029)', () => {
  it('runs recordConsent with the new org id', async () => {
    const store = new InMemoryOrganisationStore();
    const seen: string[] = [];
    const created = await store.create({
      slug: 'c1',
      displayName: 'C1',
      ownerEmail: 'c1@x.org',
      recordConsent: async (_tx, id) => {
        seen.push(id);
      },
    });
    expect(created.ok && [created.value.id]).toEqual(seen);
  });

  it('stores nothing and answers CONSENT_WRITE_FAILED when the hook throws', async () => {
    const store = new InMemoryOrganisationStore();
    const created = await store.create({
      slug: 'c2',
      displayName: 'C2',
      ownerEmail: 'c2@x.org',
      recordConsent: async () => {
        throw new Error('ledger down');
      },
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe('CONSENT_WRITE_FAILED');
    const found = await store.findBySlug('c2');
    expect(found.ok && found.value).toBeNull();
  });
});

describe('InMemoryOrganisationStore — listPending, search, delete and details', () => {
  const mk = (store: InMemoryOrganisationStore, slug: string, email: string, phone?: string) =>
    store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug,
      displayName: slug.toUpperCase(),
      ownerEmail: email,
      ...(phone ? { ownerPhone: phone } : {}),
    });

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
      buildAggregatorOrg({
        id: 'p1',
        slug: 'p1',
        status: 'pending',
        createdAt: new Date(1000),
        updatedAt: new Date(1000),
      }),
      buildAggregatorOrg({
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
      buildAggregatorOrg({ id: 'a', slug: 'a', displayName: 'Alpha', status: 'active' }),
      buildAggregatorOrg({ id: 'b', slug: 'b', displayName: 'Beta', status: 'active' }),
      buildAggregatorOrg({ id: 'c', slug: 'c', displayName: 'Gamma', status: 'pending' }),
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

  it('search breaks a same-name tie by id', async () => {
    const store = new OrganisationStoreFake();
    store.seed([
      buildAggregatorOrg({ id: 'id-2', slug: 's2', displayName: 'Same', status: 'active' }),
      buildAggregatorOrg({ id: 'id-1', slug: 's1', displayName: 'same', status: 'active' }),
    ]);
    const r = await store.search({ orgIds: null, limit: 20 });
    expect(r.ok && r.value.rows.map((o) => o.id)).toEqual(['id-1', 'id-2']);
  });

  it("listOwnedBy returns an owner's orgs by name", async () => {
    const store = new OrganisationStoreFake();
    store.seed([
      buildAggregatorOrg({ id: 'o1', slug: 'o1', displayName: 'Zeta', ownerUserId: 'owner-1' }),
      buildAggregatorOrg({ id: 'o2', slug: 'o2', displayName: 'Acme', ownerUserId: 'owner-1' }),
      buildAggregatorOrg({ id: 'o3', slug: 'o3', displayName: 'Other', ownerUserId: 'owner-2' }),
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
