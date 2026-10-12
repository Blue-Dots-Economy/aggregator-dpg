import { describe, it, expect } from 'vitest';
import { InMemoryAggregatorOrgStore } from '../memory.js';
import { AggregatorOrgStoreFake, buildAggregatorOrg, buildDefaultOrg } from '../testing.js';
import { NO_CONSENT_WRITE } from '../../consent-ledger/hook.js';

describe('InMemoryAggregatorOrgStore', () => {
  it('creates and finds an org by slug and owner email', async () => {
    const store = new InMemoryAggregatorOrgStore();
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
    const store = new InMemoryAggregatorOrgStore();
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
    const store = new InMemoryAggregatorOrgStore();
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
    const store = new InMemoryAggregatorOrgStore();
    const first = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'reusable',
      displayName: 'A',
      ownerEmail: 'a@x.org',
    });
    if (first.ok) await store.reject(first.value.id);
    const second = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'reusable',
      displayName: 'B',
      ownerEmail: 'b@x.org',
    });
    expect(second.ok).toBe(true);
  });

  it('listActive returns only active orgs, oldest first', async () => {
    const store = new InMemoryAggregatorOrgStore();
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
    if (a.ok) await store.approve(a.value.id);
    const active = await store.listActive();
    expect(active.ok && active.value.map((o) => o.slug)).toEqual(['a']);
  });

  it('approve is an atomic single-use guard (second approve returns null)', async () => {
    const store = new InMemoryAggregatorOrgStore();
    const a = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'a',
      displayName: 'A',
      ownerEmail: 'a@x.org',
    });
    if (!a.ok) return;
    const first = await store.approve(a.value.id);
    const second = await store.approve(a.value.id);
    expect(first.ok && first.value?.status).toBe('active');
    expect(second.ok && second.value).toBeNull();
  });

  it('update patches fields and bumps updatedAt', async () => {
    const store = new InMemoryAggregatorOrgStore();
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
    const store = new InMemoryAggregatorOrgStore();
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

    const rejected = await store.reject(rej.value.id);
    expect(rejected.ok && rejected.value?.status).toBe('inactive');
    expect(rejected.ok && rejected.value?.rejectedAt).toBeInstanceOf(Date);

    const approved = await store.approve(app.value.id);
    expect(approved.ok && approved.value?.status).toBe('active');
    expect(approved.ok && approved.value?.rejectedAt).toBeNull();
  });

  it('update can revive a rejected org by clearing rejected_at (#726)', async () => {
    const store = new InMemoryAggregatorOrgStore();
    const a = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'a',
      displayName: 'A',
      ownerEmail: 'a@x.org',
    });
    if (!a.ok) return;
    await store.reject(a.value.id);
    const revived = await store.update(a.value.id, { status: 'pending', rejectedAt: null });
    expect(revived.ok && revived.value.status).toBe('pending');
    expect(revived.ok && revived.value.rejectedAt).toBeNull();
  });
});

describe('InMemoryAggregatorOrgStore contact rules', () => {
  it('fails a non-canonical owner phone like the Postgres store (no row written)', async () => {
    const store = new InMemoryAggregatorOrgStore();
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
    const store = new InMemoryAggregatorOrgStore();
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
    const store = new InMemoryAggregatorOrgStore();
    const results = [
      await store.update('missing', { status: 'active' }),
      await store.approve('missing'),
      await store.reject('missing'),
    ];
    for (const r of results) expect(r.ok || r.error.code).toBe('NOT_FOUND');
  });
});

describe('InMemoryAggregatorOrgStore owners (0027)', () => {
  it('gives one owner person one account across orgs, and reports sharing', async () => {
    const store = new InMemoryAggregatorOrgStore();
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
    const store = new InMemoryAggregatorOrgStore();
    const old = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      slug: 'old',
      displayName: 'Old',
      ownerEmail: 'o@x.org',
      ownerPhone: '+919000000001',
    });
    if (!old.ok) throw new Error('seed');
    await store.reject(old.value.id);
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
    const store = new AggregatorOrgStoreFake();
    store.seed([
      buildAggregatorOrg({ id: 'b', slug: 'b', displayName: 'beta', status: 'active' }),
      buildDefaultOrg(),
      buildAggregatorOrg({ id: 'a', slug: 'a', displayName: 'Alpha', status: 'active' }),
    ]);
    const r = await store.listActive();
    expect(r.ok && r.value.map((o) => o.displayName)).toEqual(['Alpha', 'beta', 'Default']);
  });

  it('never resolves the Default org as an owner match', async () => {
    const store = new AggregatorOrgStoreFake();
    store.seed([buildDefaultOrg({ ownerEmail: 'ops@x.org', ownerPhone: '+919000000001' })]);
    expect(await store.findByOwnerEmail('ops@x.org')).toEqual({ ok: true, value: null });
    expect(await store.findByOwnerPhone('+919000000001')).toEqual({ ok: true, value: null });
  });

  it('finds the Default org and the seeded root', async () => {
    const store = new AggregatorOrgStoreFake();
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
    const store = new AggregatorOrgStoreFake();
    store.seed([buildDefaultOrg()]);
    await store.deleteById(buildDefaultOrg().id);
    const d = await store.findDefault();
    expect(d.ok && d.value).not.toBeNull();
  });

  it('carries url / locations from create', async () => {
    const store = new AggregatorOrgStoreFake();
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

describe('InMemoryAggregatorOrgStore — consent hook (0029)', () => {
  it('runs recordConsent with the new org id', async () => {
    const store = new InMemoryAggregatorOrgStore();
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
    const store = new InMemoryAggregatorOrgStore();
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
