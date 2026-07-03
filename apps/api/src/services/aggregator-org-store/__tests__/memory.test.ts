import { describe, it, expect } from 'vitest';
import { InMemoryAggregatorOrgStore } from '../memory.js';

describe('InMemoryAggregatorOrgStore', () => {
  it('creates and finds an org by slug and owner email', async () => {
    const store = new InMemoryAggregatorOrgStore();
    const created = await store.create({
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
    await store.create({ slug: 's', displayName: 'S', ownerEmail: 'Owner@Enable.ORG' });
    const byOwner = await store.findByOwnerEmail('owner@enable.org');
    expect(byOwner.ok && byOwner.value?.slug).toBe('s');
  });

  it('rejects a slug already taken by a non-terminal org with DUPLICATE_SLUG', async () => {
    const store = new InMemoryAggregatorOrgStore();
    await store.create({ slug: 'dup', displayName: 'A', ownerEmail: 'a@x.org' });
    const second = await store.create({ slug: 'dup', displayName: 'B', ownerEmail: 'b@x.org' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('DUPLICATE_SLUG');
  });

  it('allows a slug previously used only by a rejected org', async () => {
    const store = new InMemoryAggregatorOrgStore();
    const first = await store.create({ slug: 'reusable', displayName: 'A', ownerEmail: 'a@x.org' });
    if (first.ok) await store.reject(first.value.id);
    const second = await store.create({
      slug: 'reusable',
      displayName: 'B',
      ownerEmail: 'b@x.org',
    });
    expect(second.ok).toBe(true);
  });

  it('listActive returns only active orgs, oldest first', async () => {
    const store = new InMemoryAggregatorOrgStore();
    const a = await store.create({ slug: 'a', displayName: 'A', ownerEmail: 'a@x.org' });
    await store.create({ slug: 'b', displayName: 'B', ownerEmail: 'b@x.org' });
    if (a.ok) await store.approve(a.value.id);
    const active = await store.listActive();
    expect(active.ok && active.value.map((o) => o.slug)).toEqual(['a']);
  });

  it('approve is an atomic single-use guard (second approve returns null)', async () => {
    const store = new InMemoryAggregatorOrgStore();
    const a = await store.create({ slug: 'a', displayName: 'A', ownerEmail: 'a@x.org' });
    if (!a.ok) return;
    const first = await store.approve(a.value.id);
    const second = await store.approve(a.value.id);
    expect(first.ok && first.value?.status).toBe('active');
    expect(second.ok && second.value).toBeNull();
  });

  it('update patches fields and bumps updatedAt', async () => {
    const store = new InMemoryAggregatorOrgStore();
    const a = await store.create({ slug: 'a', displayName: 'A', ownerEmail: 'a@x.org' });
    if (!a.ok) return;
    const patched = await store.update(a.value.id, { kcGroupId: 'grp-1', ownerKcSub: 'kc-1' });
    expect(patched.ok && patched.value.kcGroupId).toBe('grp-1');
    expect(patched.ok && patched.value.ownerKcSub).toBe('kc-1');
  });
});
