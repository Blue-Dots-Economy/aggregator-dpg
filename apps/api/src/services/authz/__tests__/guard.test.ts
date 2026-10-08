/**
 * Unit tests for the RBAC capability checks (`@aggregator-dpg/api`): modes,
 * deny paths, and the decision input built from a Phase 5 actor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { loadRbacConfig } from '@aggregator-dpg/rbac';
import { AuthorizerFake } from '@aggregator-dpg/rbac/testing';
import { checkCapability, decisionInput, requirePermission } from '../guard.js';
import { _setRbacRuntime } from '../runtime.js';
import {
  ActorResolverFake,
  _setActorResolver,
  buildAdminActor,
  type Actor,
} from '../../auth/actor/index.js';

const { config: cfg } = await loadRbacConfig([join(process.env.CONFIG_ROOT ?? '', 'rbac.yaml')]);

function req() {
  const log = { debug: vi.fn(), warn: vi.fn() };
  return { log: log as never, method: 'GET', routeOptions: { url: '/v1/x' }, spy: log };
}

const coordinator: Actor = {
  userId: 'u-coord',
  userType: 'coordinator',
  active: true,
  orgs: [{ id: 'org-a', orgType: 'aggregator', relation: 'member', isDefault: false }],
};

function setup(mode: 'log' | 'enforce', actor: Actor | null = coordinator) {
  const authorizer = new AuthorizerFake();
  _setRbacRuntime({ mode, config: cfg, authorizer });
  const resolver = new ActorResolverFake();
  if (actor) resolver.seed('u-coord', actor);
  _setActorResolver(resolver);
  return { authorizer, resolver };
}

const caller = { subject: 's', aggregatorId: 'u-coord' };

afterEach(() => {
  _setRbacRuntime(null);
  _setActorResolver(null);
});

describe('decisionInput', () => {
  it('builds role and organisation capabilities from rbac.yaml', () => {
    const input = decisionInput(cfg, coordinator, 'profiles.view', 42);
    expect(input).toMatchObject({ capability: 'profiles.view', now: 42 });
    expect(input.actor.roleCapabilities).toEqual(cfg.roles.coordinator);
    expect(input.actor.orgs[0]?.capabilities).toEqual(cfg.permission_sets.aggregator);
    expect(input.actor.grants).toEqual([]);
  });

  it('uses an organisation override and the actor grants', () => {
    const input = decisionInput(
      cfg,
      {
        ...coordinator,
        orgs: [
          {
            id: 'o',
            orgType: 'aggregator',
            relation: 'member',
            isDefault: false,
            permissionSet: 'super_aggregator',
          },
        ],
        grants: [{ capability: 'profiles.view_pii', expiresAt: 9 }],
      },
      'profiles.view',
      0,
    );
    expect(input.actor.orgs[0]?.capabilities).toEqual(cfg.permission_sets.super_aggregator);
    expect(input.actor.grants).toHaveLength(1);
  });
});

describe('requirePermission', () => {
  it('does nothing when RBAC is off', async () => {
    const r = req();
    expect(await requirePermission(r, caller, 'profiles.view')).toEqual({
      allowed: true,
      mode: 'off',
    });
    expect(r.spy.warn).not.toHaveBeenCalled();
  });

  it('allows what the role and the organisation set hold', async () => {
    setup('enforce');
    expect(await requirePermission(req(), caller, 'profiles.view')).toMatchObject({
      allowed: true,
      decision: { allow: true },
    });
  });

  it('denies in enforce mode and logs a failure', async () => {
    setup('enforce');
    const r = req();
    const out = await requirePermission(r, caller, 'profiles.view_pii');
    expect(out).toMatchObject({ allowed: false, decision: { reasons: ['not_in_role'] } });
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
    const out = await requirePermission(r, caller, 'profiles.view_pii');
    expect(out).toMatchObject({ allowed: true, decision: { allow: false } });
    expect(r.spy.warn).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
  });

  it('denies an unknown caller', async () => {
    setup('enforce', null);
    const out = await requirePermission(req(), { subject: 'nobody' }, 'profiles.view');
    expect(out).toMatchObject({ allowed: false, decision: { reasons: ['unknown_actor'] } });
  });

  it('denies when the resolver is unavailable', async () => {
    setup('enforce').resolver.failWith = 'db down';
    const out = await requirePermission(req(), caller, 'profiles.view');
    expect(out.decision).toEqual({ allow: false, reasons: ['actor_unavailable'] });
  });

  it('denies when the engine is unreachable', async () => {
    setup('enforce').authorizer.failWith();
    const out = await requirePermission(req(), caller, 'profiles.view');
    expect(out.decision).toEqual({ allow: false, reasons: ['engine_unavailable'] });
  });
});

describe('checkCapability', () => {
  it('honours an unexpired grant on a resolved actor', async () => {
    setup('enforce');
    const actor = {
      ...coordinator,
      grants: [{ capability: 'profiles.view_pii' as const, expiresAt: 100 }],
    };
    expect((await checkCapability(req(), actor, 'profiles.view_pii', 99)).allowed).toBe(true);
    expect((await checkCapability(req(), actor, 'profiles.view_pii', 100)).allowed).toBe(false);
  });

  it('lets a network admin repair access but not an aggregator admin', async () => {
    setup('enforce');
    const nf = buildAdminActor({
      orgs: [{ id: 'nf', orgType: 'network_facilitator', relation: 'owner', isDefault: false }],
    });
    expect((await checkCapability(req(), nf, 'network.administer')).allowed).toBe(true);
    expect((await checkCapability(req(), buildAdminActor(), 'network.administer')).allowed).toBe(
      false,
    );
  });

  it('lets an aggregator admin manage its organisation', async () => {
    setup('enforce');
    expect((await checkCapability(req(), buildAdminActor(), 'org.manage')).allowed).toBe(true);
  });
});
