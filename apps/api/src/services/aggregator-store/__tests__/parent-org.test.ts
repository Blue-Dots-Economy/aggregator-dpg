import { describe, it, expect } from 'vitest';
import { InMemoryAggregatorStore } from '../memory.js';
import { AggregatorStoreFake, buildAggregator } from '../testing.js';

describe('aggregator store parentOrgId', () => {
  it('persists parentOrgId on create and returns it', async () => {
    const store = new InMemoryAggregatorStore();
    const r = await store.create({
      orgSlug: 'c1',
      actorType: 'aggregator',
      name: 'Coord 1',
      type: 'seeker',
      contact: { name: 'A', phone: '+919000000001', email: 'c1@x.org' },
      consent: {
        value: true,
        given_at: '2026-01-01T00:00:00Z',
        valid_till: '2027-01-01T00:00:00Z',
      },
      createdBy: 'self',
      updatedBy: 'self',
      parentOrgId: 'org-1',
    });
    expect(r.ok && r.value.parentOrgId).toBe('org-1');
  });

  it('defaults parentOrgId to null when omitted', async () => {
    const store = new InMemoryAggregatorStore();
    const r = await store.create({
      orgSlug: 'c2',
      actorType: 'aggregator',
      name: 'Coord 2',
      type: 'seeker',
      contact: { name: 'A', phone: '+919000000002', email: 'c2@x.org' },
      consent: {
        value: true,
        given_at: '2026-01-01T00:00:00Z',
        valid_till: '2027-01-01T00:00:00Z',
      },
      createdBy: 'self',
      updatedBy: 'self',
    });
    expect(r.ok && r.value.parentOrgId).toBeNull();
  });

  it("findByParentOrgId returns only that org's coordinators", async () => {
    const store = new AggregatorStoreFake();
    store.seed([
      buildAggregator({ id: 'c1', orgSlug: 'c1', contactEmail: 'c1@x.org', parentOrgId: 'org-1' }),
      buildAggregator({ id: 'c2', orgSlug: 'c2', contactEmail: 'c2@x.org', parentOrgId: 'org-2' }),
      buildAggregator({ id: 'c3', orgSlug: 'c3', contactEmail: 'c3@x.org', parentOrgId: 'org-1' }),
    ]);
    const list = await store.findByParentOrgId('org-1');
    expect(list.ok && list.value.map((a) => a.id).sort()).toEqual(['c1', 'c3']);
  });

  it('update can change parentOrgId', async () => {
    const store = new AggregatorStoreFake();
    store.seed([
      buildAggregator({ id: 'c1', orgSlug: 'c1', contactEmail: 'c1@x.org', parentOrgId: null }),
    ]);
    const r = await store.update('c1', { parentOrgId: 'org-9', updatedBy: 'test' });
    expect(r.ok && r.value.parentOrgId).toBe('org-9');
  });
});
