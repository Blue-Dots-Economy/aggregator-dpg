import { describe, it, expect, vi } from 'vitest';
import type { OrganisationConfig } from '@aggregator-dpg/network-config/interface';
import {
  OrganisationStoreFake,
  buildDefaultOrg,
  buildOrganisation,
} from '../organisation-store/index.js';
import { warnOrgTreeOverLimits } from '../org-tree-warnings.js';

const ROOT = 'root';

const cfg = (hierarchy: Partial<OrganisationConfig['hierarchy']> = {}): OrganisationConfig => ({
  hierarchy: { max_depth: 2, max_total_orgs: 50, ...hierarchy },
  known_as: {
    values: [{ key: 'state', name: 'State', depths: [1] }],
    suggest: [],
  },
});

/** Root → A (state) → B → C (state, depth 3), plus a rejected D at depth 3 and the Default org. */
function seeded(): OrganisationStoreFake {
  const store = new OrganisationStoreFake();
  store.seedRoot(buildOrganisation({ id: ROOT, slug: 'network', status: 'active', depth: 0 }));
  store.seed([
    buildDefaultOrg({ parentId: ROOT }),
    buildOrganisation({ id: 'a', slug: 'a', status: 'active', parentId: ROOT, knownAs: 'state' }),
    buildOrganisation({ id: 'b', slug: 'b', status: 'active', parentId: 'a', depth: 2 }),
    buildOrganisation({ id: 'c', slug: 'c', parentId: 'b', depth: 3, knownAs: 'state' }),
    buildOrganisation({ id: 'd', slug: 'd', status: 'inactive', parentId: 'b', depth: 3 }),
  ]);
  return store;
}

const checks = (warn: ReturnType<typeof vi.fn>) =>
  Object.fromEntries(
    warn.mock.calls.map(([e]) => {
      const { check, ...rest } = e as { check: string };
      return [check, rest];
    }),
  );

describe('warnOrgTreeOverLimits', () => {
  it('logs one warning per kind with counts only', async () => {
    const warn = vi.fn();
    await warnOrgTreeOverLimits(seeded(), cfg({ max_children: 1, max_total_orgs: 2 }), { warn });
    expect(checks(warn)).toEqual({
      depth: expect.objectContaining({ org_count: 1, max_depth: 2 }),
      total: expect.objectContaining({ total_orgs: 3, max_total_orgs: 2 }),
      known_as: expect.objectContaining({ org_count: 1 }),
    });
    for (const [e] of warn.mock.calls) {
      expect(e).toMatchObject({ operation: 'orgTree.bootCheck', status: 'success' });
    }
  });

  it('counts orgs with more children than max_children, the root included', async () => {
    const store = seeded();
    store.seed([buildOrganisation({ id: 'e', slug: 'e', parentId: ROOT })]);
    const warn = vi.fn();
    await warnOrgTreeOverLimits(store, cfg({ max_depth: 3, max_children: 1 }), { warn });
    expect(checks(warn).children).toMatchObject({ org_count: 1, max_children: 1 });
  });

  it('logs only the kinds over a limit', async () => {
    const warn = vi.fn();
    await warnOrgTreeOverLimits(seeded(), cfg({ max_depth: 3 }), { warn });
    // C's "state" is not allowed at depth 3.
    expect(Object.keys(checks(warn))).toEqual(['known_as']);
  });

  it('counts a known_as key that is no longer configured', async () => {
    const store = seeded();
    store.seed([
      buildOrganisation({ id: 'c', slug: 'c', parentId: 'b', depth: 3, knownAs: 'gone' }),
    ]);
    const warn = vi.fn();
    await warnOrgTreeOverLimits(store, cfg({ max_depth: 3 }), { warn });
    expect(checks(warn).known_as).toMatchObject({ org_count: 1 });
  });

  it('logs a failure and returns when the store cannot be read', async () => {
    const store = seeded();
    vi.spyOn(store, 'search').mockResolvedValueOnce({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    const warn = vi.fn();
    await warnOrgTreeOverLimits(store, cfg(), { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      operation: 'orgTree.bootCheck',
      status: 'failure',
      error: 'down',
    });
  });
});
