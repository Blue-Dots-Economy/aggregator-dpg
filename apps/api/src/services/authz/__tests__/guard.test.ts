/**
 * Unit tests for the RBAC route guard (`@aggregator-dpg/api`, R0): modes,
 * deny paths, and the decision input it builds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRbacConfig } from '@aggregator-dpg/rbac';
import { AuthorizerFake } from '@aggregator-dpg/rbac/testing';
import { join } from 'node:path';
import { requirePermission } from '../guard.js';
import { _setRbacRuntime } from '../runtime.js';
import { InMemoryActorResolver, _setActorResolver } from '../actor-resolver/index.js';
import type { ResolvedActor } from '../actor-resolver/index.js';

const { config: cfg } = await loadRbacConfig([join(process.env.CONFIG_ROOT ?? '', 'rbac.yaml')]);

function req() {
  const log = { debug: vi.fn(), warn: vi.fn() };
  return { log: log as never, method: 'GET', routeOptions: { url: '/v1/x' }, spy: log };
}

const coordinator: ResolvedActor = {
  userId: 'u-coord',
  userType: 'coordinator',
  active: true,
  orgs: [{ id: 'org-a', orgType: 'aggregator', relation: 'member', permissionSet: null }],
  grants: [],
};

function setup(mode: 'log' | 'enforce', actor: ResolvedActor | null = coordinator) {
  const authorizer = new AuthorizerFake();
  _setRbacRuntime({ mode, config: cfg, authorizer });
  const resolver = new InMemoryActorResolver();
  if (actor) resolver.seed(actor);
  _setActorResolver(resolver);
  return authorizer;
}

afterEach(() => {
  _setRbacRuntime(null);
  _setActorResolver(null);
});

describe('requirePermission', () => {
  it('does nothing when RBAC is off', async () => {
    const r = req();
    expect(
      await requirePermission(r, { subject: 's', aggregatorId: 'u-coord' }, 'profiles.view'),
    ).toEqual({
      allowed: true,
      mode: 'off',
    });
    expect(r.spy.warn).not.toHaveBeenCalled();
  });

  it('allows a coordinator to view its own tenant', async () => {
    setup('enforce');
    const out = await requirePermission(
      req(),
      { subject: 's', aggregatorId: 'u-coord' },
      'profiles.view',
      {
        tenantUserId: 'u-coord',
      },
    );
    expect(out).toMatchObject({ allowed: true, mode: 'enforce', decision: { allow: true } });
  });

  it('builds the input from rbac.yaml', async () => {
    const authz = setup('log');
    await requirePermission(
      req(),
      { subject: 's', aggregatorId: 'u-coord' },
      'profiles.view',
      undefined,
      42,
    );
    const input = authz.calls[0];
    expect(input?.now).toBe(42);
    expect(input?.target).toBeUndefined();
    expect(input?.actor.roleCapabilities).toEqual(cfg.roles.coordinator);
    expect(input?.actor.orgs[0]?.capabilities).toEqual(cfg.permission_sets.aggregator);
  });

  it('denies in enforce mode and logs a failure', async () => {
    setup('enforce');
    const r = req();
    const out = await requirePermission(
      r,
      { subject: 's', aggregatorId: 'u-coord' },
      'profiles.view_pii',
    );
    expect(out).toMatchObject({
      allowed: false,
      decision: { allow: false, reasons: ['not_in_role'] },
    });
    expect(r.spy.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'rbac.decide',
        status: 'failure',
        capability: 'profiles.view_pii',
      }),
    );
  });

  it('only logs a deny in log mode', async () => {
    setup('log');
    const r = req();
    const out = await requirePermission(
      r,
      { subject: 's', aggregatorId: 'u-coord' },
      'profiles.view_pii',
    );
    expect(out.allowed).toBe(true);
    expect(out.decision?.allow).toBe(false);
    expect(r.spy.warn).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
  });

  it('denies an unknown caller', async () => {
    setup('enforce', null);
    const out = await requirePermission(req(), { subject: 'nobody' }, 'profiles.view');
    expect(out.decision).toEqual({ allow: false, reasons: ['unknown_actor'] });
    expect(out.allowed).toBe(false);
  });

  it('denies when the engine is unreachable', async () => {
    setup('enforce').failWith();
    const out = await requirePermission(
      req(),
      { subject: 's', aggregatorId: 'u-coord' },
      'profiles.view',
    );
    expect(out.decision).toEqual({ allow: false, reasons: ['engine_unavailable'] });
  });

  it('denies when the database is unavailable', async () => {
    setup('enforce');
    _setActorResolver({
      resolve: async () => ({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'x' } }),
      orgChain: async () => ({ ok: true, value: [] }),
    } as never);
    const out = await requirePermission(
      req(),
      { subject: 's', aggregatorId: 'u-coord' },
      'profiles.view',
    );
    expect(out.decision).toEqual({ allow: false, reasons: ['actor_unavailable'] });
  });

  it('honours an unexpired grant', async () => {
    setup('enforce', {
      ...coordinator,
      grants: [{ capability: 'profiles.view_pii', expiresAt: 100 }],
    });
    const ok = await requirePermission(
      req(),
      { subject: 's', aggregatorId: 'u-coord' },
      'profiles.view_pii',
      undefined,
      99,
    );
    const late = await requirePermission(
      req(),
      { subject: 's', aggregatorId: 'u-coord' },
      'profiles.view_pii',
      undefined,
      100,
    );
    expect(ok.allowed).toBe(true);
    expect(late.allowed).toBe(false);
  });
});
