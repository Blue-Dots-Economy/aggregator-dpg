/**
 * Unit tests for RBAC boot-time init and the role snapshot refresh
 * (`@aggregator-dpg/api`; design §5). The built-in roles are seeded into the
 * database by migration 0031; here the in-memory catalogue stands in for that
 * seed via `setRoles(BUILTIN_ROLES)`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_ROLES } from '@aggregator-dpg/rbac';
import { buildRole } from '@aggregator-dpg/rbac/testing';
import {
  getRbacRuntime,
  initRbac,
  publishCurrentToEdge,
  refreshRbacCatalogue,
  stopRbacRefresh,
  _setRbacRuntime,
} from '../runtime.js';
import { InMemoryRbacCatalogue, _setRbacCatalogue } from '../../rbac-catalogue/index.js';
import { config } from '../../../config.js';

const savedCustomRoles = config.RBAC_CUSTOM_ROLES_ENABLED;
let store: InMemoryRbacCatalogue;

beforeEach(() => {
  store = new InMemoryRbacCatalogue();
  // The catalogue as migration 0031 leaves it at start: the built-in roles seeded.
  store.setRoles(BUILTIN_ROLES);
  _setRbacCatalogue(store);
  // Most tests here exercise the full catalogue (built-in + custom); the
  // built-in-only filtering is covered on its own below.
  config.RBAC_CUSTOM_ROLES_ENABLED = true;
});

afterEach(() => {
  stopRbacRefresh();
  _setRbacRuntime(null);
  _setRbacCatalogue(null);
  config.RBAC_CUSTOM_ROLES_ENABLED = savedCustomRoles;
  vi.useRealTimers();
});

const viewer = buildRole({ key: 'viewer', permissions: ['profiles.view'] });
const roleKeys = () => [...getRbacRuntime()!.roles.byKey.keys()].sort();

describe('initRbac', () => {
  it('loads nothing when off', async () => {
    await initRbac('off');
    expect(getRbacRuntime()).toBeNull();
  });

  it('loads the seeded built-in roles', async () => {
    await initRbac('enforce', 0);
    expect(roleKeys()).toEqual([
      'coordinator',
      'data_export',
      'network_admin',
      'org_admin',
      'org_onboarder',
      'pii_access',
    ]);
    expect(getRbacRuntime()).toMatchObject({ mode: 'enforce', catalogueRevision: 'r1' });
  });

  it('loads custom roles alongside the built-ins', async () => {
    store.setRoles([...store.storedRoles(), viewer]);
    await initRbac('log', 0);
    expect(roleKeys()).toContain('viewer');
  });

  it('fails boot when the store is down', async () => {
    store.failWith({ code: 'DB_UNAVAILABLE', message: 'down' });
    await expect(initRbac('log', 0)).rejects.toMatchObject({ code: 'RBAC_CATALOGUE_UNAVAILABLE' });
  });

  it('fails boot when a stored role breaks a rule', async () => {
    store.setRoles([...store.storedRoles(), buildRole({ key: 'bad', assignedBy: null })]);
    await expect(initRbac('log', 0)).rejects.toMatchObject({ code: 'RBAC_CONFIG_INVALID' });
  });
});

describe('refreshRbacCatalogue', () => {
  it('does nothing when RBAC is off', async () => {
    await initRbac('off');
    expect(await refreshRbacCatalogue()).toBe('off');
  });

  it('keeps the snapshot when the revision did not change', async () => {
    await initRbac('log', 0);
    const before = getRbacRuntime();
    expect(await refreshRbacCatalogue()).toBe('unchanged');
    expect(getRbacRuntime()).toBe(before);
  });

  it('reloads when a role changed', async () => {
    await initRbac('log', 0);
    store.setRoles([...store.storedRoles(), viewer]);
    expect(await refreshRbacCatalogue()).toBe('reloaded');
    expect(roleKeys()).toContain('viewer');
    expect(getRbacRuntime()!.catalogueRevision).toBe('r2');
  });

  it('keeps the last good snapshot when the new catalogue is invalid', async () => {
    await initRbac('log', 0);
    const before = getRbacRuntime()!.roles;
    store.setRoles(store.storedRoles().filter((r) => r.key !== 'org_admin'));
    expect(await refreshRbacCatalogue()).toBe('failed');
    expect(getRbacRuntime()!.roles).toBe(before);
    expect(getRbacRuntime()!.catalogueRevision).toBe('r1');
  });

  it('keeps the snapshot when the store is down', async () => {
    await initRbac('log', 0);
    const before = getRbacRuntime();
    store.failWith({ code: 'DB_UNAVAILABLE', message: 'down' });
    expect(await refreshRbacCatalogue()).toBe('failed');
    expect(getRbacRuntime()).toBe(before);
  });

  it('queues an overlapping call behind the one in flight', async () => {
    await initRbac('log', 0);
    store.setRoles([...store.storedRoles(), viewer]);
    const load = vi.spyOn(store, 'load');
    const [a, b] = await Promise.all([refreshRbacCatalogue(), refreshRbacCatalogue()]);
    // The first run applies the change; the second re-reads and finds nothing
    // left to do. Only one load, because the revision already matched.
    expect([a, b]).toEqual(['reloaded', 'unchanged']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not hand a writer a read taken before its write', async () => {
    await initRbac('log', 0);
    // Hold the first refresh open, then "commit" a role while it is in flight.
    let release = (): void => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    // The in-flight run reads the revision as it was before the write — the
    // exact race that joining used to paper over.
    const preWrite = getRbacRuntime()?.catalogueRevision ?? '';
    const revision = vi.spyOn(store, 'revision');
    revision.mockImplementationOnce(async () => {
      await held;
      return { ok: true as const, value: preWrite };
    });

    const inFlight = refreshRbacCatalogue();
    store.setRoles([...store.storedRoles(), viewer]);
    const writer = refreshRbacCatalogue();
    release();

    await inFlight;
    // Joining would have reported `unchanged` off the pre-write read.
    expect(await writer).toBe('reloaded');
    expect(getRbacRuntime()?.roles.byKey.has(viewer.key)).toBe(true);
  });

  it('runs on the timer and stops with stopRbacRefresh', async () => {
    vi.useFakeTimers();
    await initRbac('log', 1000);
    const builtins = store.storedRoles();
    store.setRoles([...builtins, viewer]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(roleKeys()).toContain('viewer');

    stopRbacRefresh();
    store.setRoles(builtins);
    await vi.advanceTimersByTimeAsync(5000);
    expect(roleKeys()).toContain('viewer');
  });
});

describe('CUSTOM-ROLES flag gates the snapshot', () => {
  it('loads built-in roles only when the flag is off', async () => {
    config.RBAC_CUSTOM_ROLES_ENABLED = false;
    await initRbac('log', 0);
    const builtins = roleKeys();
    expect(builtins).not.toContain('viewer');
    // A stored custom role is dropped on load, so a refresh never adds it.
    store.setRoles([...store.storedRoles(), viewer]);
    expect(await refreshRbacCatalogue()).toBe('reloaded');
    expect(roleKeys()).toEqual(builtins);
    expect(roleKeys()).not.toContain('viewer');
  });

  it('includes custom roles when the flag is on', async () => {
    // beforeEach sets the flag on.
    store.setRoles([...store.storedRoles(), viewer]);
    await initRbac('log', 0);
    expect(roleKeys()).toContain('viewer');
  });
});

describe('edge catalogue publishing', () => {
  const savedEdge = config.RBAC_EDGE_MODE;
  afterEach(() => {
    config.RBAC_EDGE_MODE = savedEdge;
    vi.restoreAllMocks();
  });

  /** Spies on fetch, answering OPA's 204, and returns the published bodies. */
  function opa() {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    return () =>
      spy.mock.calls.map(
        (c) => JSON.parse(String(c[1]?.body)) as { mode: string; revision: string; roles: object },
      );
  }

  it('publishes nothing while the edge is off', async () => {
    config.RBAC_EDGE_MODE = 'off';
    const bodies = opa();
    await initRbac('enforce', 0);
    expect(await publishCurrentToEdge()).toBe('off');
    expect(bodies()).toHaveLength(0);
  });

  it('publishes the snapshot at boot with the edge mode', async () => {
    config.RBAC_EDGE_MODE = 'log';
    const bodies = opa();
    await initRbac('enforce', 0);
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).toMatchObject({
      mode: 'log',
      revision: getRbacRuntime()!.catalogueRevision,
    });
    expect(Object.keys(bodies()[0]!.roles)).toContain('coordinator');
  });

  it('re-publishes the current snapshot on demand (each refresh tick)', async () => {
    config.RBAC_EDGE_MODE = 'enforce';
    const bodies = opa();
    await initRbac('log', 0);
    expect(await publishCurrentToEdge()).toBe('published');
    expect(bodies()).toHaveLength(2);
  });

  it('publishes again right after a reload', async () => {
    config.RBAC_EDGE_MODE = 'enforce';
    const bodies = opa();
    await initRbac('log', 0);
    store.setRoles([...store.storedRoles(), viewer]);
    expect(await refreshRbacCatalogue()).toBe('reloaded');
    expect(bodies()).toHaveLength(2);
    expect(Object.keys(bodies()[1]!.roles)).toContain('viewer');
  });

  it('boots even when the sidecar is down (the next tick retries)', async () => {
    config.RBAC_EDGE_MODE = 'enforce';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(initRbac('enforce', 0)).resolves.toBeUndefined();
    expect(await publishCurrentToEdge()).toBe('failed');
  });

  it('refuses to boot with the edge on and RBAC off', async () => {
    config.RBAC_EDGE_MODE = 'log';
    await expect(initRbac('off')).rejects.toMatchObject({ code: 'RBAC_CONFIG_INVALID' });
  });
});
