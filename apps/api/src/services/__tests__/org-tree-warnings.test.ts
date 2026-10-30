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
  it('logs one entry per kind with counts only; a total over the limit is an error', async () => {
    const warn = vi.fn();
    const error = vi.fn();
    await warnOrgTreeOverLimits(seeded(), cfg({ max_children: 1, max_total_orgs: 2 }), {
      warn,
      error,
    });
    expect(checks(warn)).toEqual({
      depth: expect.objectContaining({ org_count: 1, max_depth: 2 }),
      known_as: expect.objectContaining({ org_count: 1 }),
    });
    expect(checks(error)).toEqual({
      total: expect.objectContaining({
        total_orgs: 3,
        max_total_orgs: 2,
        registration: 'closed',
      }),
    });
    for (const [e] of [...warn.mock.calls, ...error.mock.calls]) {
      expect(e).toMatchObject({ operation: 'orgTree.bootCheck', status: 'success' });
    }
  });

  it('warns, not errors, when the total is exactly at the limit', async () => {
    const warn = vi.fn();
    const error = vi.fn();
    await warnOrgTreeOverLimits(seeded(), cfg({ max_depth: 3, max_total_orgs: 3 }), {
      warn,
      error,
    });
    expect(checks(warn).total).toMatchObject({ total_orgs: 3, registration: 'closed' });
    expect(error).not.toHaveBeenCalled();
  });

  it('counts orgs with more children than max_children, the root included', async () => {
    const store = seeded();
    store.seed([buildOrganisation({ id: 'e', slug: 'e', parentId: ROOT })]);
    const warn = vi.fn();
    await warnOrgTreeOverLimits(store, cfg({ max_depth: 3, max_children: 1 }), {
      warn,
      error: vi.fn(),
    });
    expect(checks(warn).children).toMatchObject({ org_count: 1, max_children: 1 });
  });

  it('logs only the kinds over a limit', async () => {
    const warn = vi.fn();
    await warnOrgTreeOverLimits(seeded(), cfg({ max_depth: 3 }), { warn, error: vi.fn() });
    // C's "state" is not allowed at depth 3.
    expect(Object.keys(checks(warn))).toEqual(['known_as']);
  });

  it('counts a known_as key that is no longer configured', async () => {
    const store = seeded();
    store.seed([
      buildOrganisation({ id: 'c', slug: 'c', parentId: 'b', depth: 3, knownAs: 'gone' }),
    ]);
    const warn = vi.fn();
    await warnOrgTreeOverLimits(store, cfg({ max_depth: 3 }), { warn, error: vi.fn() });
    expect(checks(warn).known_as).toMatchObject({ org_count: 1 });
  });

  it('logs a failure as an error and returns when the store cannot be read', async () => {
    const store = seeded();
    vi.spyOn(store, 'search').mockResolvedValueOnce({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    const warn = vi.fn();
    const error = vi.fn();
    await warnOrgTreeOverLimits(store, cfg(), { warn, error });
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      operation: 'orgTree.bootCheck',
      status: 'failure',
      error: 'down',
    });
  });
});
