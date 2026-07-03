import { describe, it, expect, afterEach } from 'vitest';
import {
  AggregatorStoreFake,
  buildAggregator,
  _setAggregatorStore,
} from '../aggregator-store/index.js';
import { listOrgCoordinators } from '../org-view.js';

afterEach(() => _setAggregatorStore(null));

describe('listOrgCoordinators', () => {
  it('returns only the coordinators whose parent_org_id matches', async () => {
    const store = new AggregatorStoreFake();
    store.seed([
      buildAggregator({ id: 'c1', orgSlug: 'c1', contactEmail: 'c1@x.org', parentOrgId: 'org-1' }),
      buildAggregator({ id: 'c2', orgSlug: 'c2', contactEmail: 'c2@x.org', parentOrgId: 'org-2' }),
      buildAggregator({ id: 'c3', orgSlug: 'c3', contactEmail: 'c3@x.org', parentOrgId: 'org-1' }),
    ]);
    _setAggregatorStore(store);
    const r = await listOrgCoordinators('org-1');
    expect(r.ok && r.value.map((a) => a.id).sort()).toEqual(['c1', 'c3']);
  });

  it('returns an empty list for an org with no coordinators', async () => {
    const store = new AggregatorStoreFake();
    _setAggregatorStore(store);
    const r = await listOrgCoordinators('org-empty');
    expect(r.ok && r.value).toEqual([]);
  });
});
