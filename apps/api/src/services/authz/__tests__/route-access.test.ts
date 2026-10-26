/**
 * Unit tests for route access declarations (`@aggregator-dpg/api`, RBAC R1):
 * the boot check, the per-route enforcement, and the declared route table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest, RouteOptions } from 'fastify';
import { CAPABILITIES } from '@aggregator-dpg/rbac';
import { AuthorizerFake } from '@aggregator-dpg/rbac/testing';
import { buildApp } from '../../../app.js';
import { config } from '../../../config.js';
import {
  assertRouteDeclared,
  enforceActorRouteAccess,
  enforceRouteAccess,
  enforcedCapabilities,
  exportRouteTable,
  isServiceAccount,
  listDeclaredRoutes,
  _resetDeclaredRoutes,
  type RouteAccess,
} from '../route-access.js';
import { _setRbacRuntime } from '../runtime.js';
import { shippedRoleIndex } from '../testing.js';
import { ActorResolverFake, _setActorResolver, buildAdminActor } from '../../auth/actor/index.js';

const roles = await shippedRoleIndex();

afterEach(() => {
  _setRbacRuntime(null);
  _setActorResolver(null);
});

function route(
  rbac?: RouteAccess,
  method: RouteOptions['method'] = 'GET',
  url = '/v1/x',
): RouteOptions {
  return {
    method,
    url,
    handler: async () => undefined,
    ...(rbac ? { config: { rbac } } : {}),
  } as RouteOptions;
}

function req(rbac: RouteAccess) {
  const warn = vi.fn();
  return {
    r: {
      routeOptions: { config: { rbac }, url: '/v1/x' },
      method: 'GET',
      log: { warn, debug: vi.fn() },
    } as unknown as FastifyRequest,
    warn,
  };
}

function setup(mode: 'log' | 'enforce', active = true) {
  _setRbacRuntime({ mode, roles, authorizer: new AuthorizerFake() });
  const resolver = new ActorResolverFake();
  resolver.seed('u1', {
    userId: 'u1',
    userType: 'coordinator',
    active,
    orgs: [{ id: 'org-a', orgType: 'aggregator', relation: 'member', isDefault: false }],
  });
  _setActorResolver(resolver);
}

describe('assertRouteDeclared', () => {
  it('accepts a declared route', () => {
    expect(() => assertRouteDeclared(route({ capability: 'profiles.view' }))).not.toThrow();
  });

  it('refuses a route without a declaration', () => {
    expect(() => assertRouteDeclared(route())).toThrow(/no config.rbac/);
  });

  it('refuses an unknown capability', () => {
    expect(() => assertRouteDeclared(route({ capability: 'nope' } as never))).toThrow(
      /unknown capability/,
    );
  });

  it('accepts an any-of declaration and refuses an empty or unknown one', () => {
    expect(() =>
      assertRouteDeclared(route({ anyCapability: ['org.manage', 'orgs.onboard'] })),
    ).not.toThrow();
    expect(() => assertRouteDeclared(route({ anyCapability: [] }))).toThrow(/empty anyCapability/);
    expect(() =>
      assertRouteDeclared(route({ anyCapability: ['org.manage', 'nope'] } as never)),
    ).toThrow(/unknown capability/);
  });

  it('skips HEAD and plugin routes', () => {
    expect(() => assertRouteDeclared(route(undefined, 'HEAD'))).not.toThrow();
    expect(() =>
      assertRouteDeclared(route(undefined, 'GET', '/api/reference/openapi.json')),
    ).not.toThrow();
  });
});

describe('isServiceAccount', () => {
  it('matches only service-account usernames', () => {
    expect(isServiceAccount('service-account-aggregator-bff')).toBe(true);
    expect(isServiceAccount('alice')).toBe(false);
    expect(isServiceAccount(undefined)).toBe(false);
  });
});

describe('enforceRouteAccess', () => {
  const caller = { subject: 's', aggregatorId: 'u1' };

  it('does nothing when RBAC is off', async () => {
    await expect(
      enforceRouteAccess(req({ capability: 'profiles.view_pii' }).r, caller),
    ).resolves.toBeUndefined();
  });

  it('lets an allowed capability through', async () => {
    setup('enforce');
    await expect(
      enforceRouteAccess(req({ capability: 'profiles.view' }).r, caller),
    ).resolves.toBeUndefined();
  });

  it('returns 403 for a denied capability in enforce mode', async () => {
    setup('enforce');
    await expect(
      enforceRouteAccess(req({ capability: 'profiles.view_pii' }).r, caller),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      fields: { permission: 'profiles.view_pii' },
    });
  });

  it('only logs a denied capability in log mode', async () => {
    setup('log');
    await expect(
      enforceRouteAccess(req({ capability: 'profiles.view_pii' }).r, caller),
    ).resolves.toBeUndefined();
  });

  it('lets a caller holding any one of the capabilities through', async () => {
    setup('enforce');
    await expect(
      enforceRouteAccess(req({ anyCapability: ['profiles.view_pii', 'profiles.view'] }).r, caller),
    ).resolves.toBeUndefined();
  });

  it('returns 403 naming every capability when none is held', async () => {
    setup('enforce');
    await expect(
      enforceRouteAccess(
        req({ anyCapability: ['profiles.view_pii', 'profiles.export'] }).r,
        caller,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      fields: { permission: 'profiles.view_pii|profiles.export' },
    });
  });

  it('only logs a missing any-of capability, or an unknown caller, in log mode', async () => {
    setup('log');
    const any = req({ anyCapability: ['profiles.view_pii', 'profiles.export'] });
    await expect(enforceRouteAccess(any.r, caller)).resolves.toBeUndefined();
    const unknown = req({ anyCapability: ['profiles.view'] });
    await expect(enforceRouteAccess(unknown.r, { subject: 'nobody' })).resolves.toBeUndefined();
    expect(unknown.warn).toHaveBeenCalled();
  });

  it('refuses an unknown caller on an any-of route in enforce mode', async () => {
    setup('enforce');
    await expect(
      enforceRouteAccess(req({ anyCapability: ['profiles.view'] }).r, { subject: 'nobody' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires a service account for service routes', async () => {
    setup('enforce');
    await expect(enforceRouteAccess(req({ access: 'service' }).r, caller)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      enforceRouteAccess(req({ access: 'service' }).r, {
        ...caller,
        preferredUsername: 'service-account-x',
      }),
    ).resolves.toBeUndefined();
  });

  it('logs and lets a non-service caller through in log mode', async () => {
    setup('log');
    const { r, warn } = req({ access: 'service' });
    await expect(enforceRouteAccess(r, caller)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'rbac.access',
        reasons: ['not_service_account'],
        status: 'skipped',
      }),
    );
  });

  it('requires an active account for self routes', async () => {
    setup('enforce', false);
    await expect(enforceRouteAccess(req({ access: 'self' }).r, caller)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('accepts an inactive but known account for signed_in routes', async () => {
    setup('enforce', false);
    await expect(
      enforceRouteAccess(req({ access: 'signed_in' }).r, caller),
    ).resolves.toBeUndefined();
  });

  it('refuses an unknown account for signed_in routes', async () => {
    setup('enforce');
    await expect(
      enforceRouteAccess(req({ access: 'signed_in' }).r, { subject: 'nobody' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('leaves link-token and public routes to the route', async () => {
    setup('enforce');
    await expect(
      enforceRouteAccess(req({ access: 'link_token' }).r, { subject: 'x' }),
    ).resolves.toBeUndefined();
    await expect(
      enforceRouteAccess(req({ access: 'public' }).r, { subject: 'x' }),
    ).resolves.toBeUndefined();
  });
});

describe('enforceActorRouteAccess', () => {
  it('does nothing when RBAC is off', async () => {
    await expect(
      enforceActorRouteAccess(req({ capability: 'network.administer' }).r, buildAdminActor()),
    ).resolves.toBeUndefined();
  });

  it('checks a console route capability on the resolved actor', async () => {
    setup('enforce');
    await expect(
      enforceActorRouteAccess(req({ capability: 'org.manage' }).r, buildAdminActor()),
    ).resolves.toBeUndefined();
    await expect(
      enforceActorRouteAccess(req({ capability: 'network.administer' }).r, buildAdminActor()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', fields: { permission: 'network.administer' } });
  });

  it('checks an any-of console route on the resolved actor', async () => {
    setup('enforce');
    await expect(
      enforceActorRouteAccess(
        req({ anyCapability: ['network.administer', 'org.manage'] }).r,
        buildAdminActor(),
      ),
    ).resolves.toBeUndefined();
    await expect(
      enforceActorRouteAccess(
        req({ anyCapability: ['network.administer', 'orgs.onboard'] }).r,
        buildAdminActor(),
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      fields: { permission: 'network.administer|orgs.onboard' },
    });
  });

  it('only logs a missing console capability in log mode', async () => {
    setup('log');
    await expect(
      enforceActorRouteAccess(req({ capability: 'network.administer' }).r, buildAdminActor()),
    ).resolves.toBeUndefined();
  });

  it('accepts a signed-in actor and refuses an inactive one on self routes', async () => {
    setup('enforce');
    await expect(
      enforceActorRouteAccess(req({ access: 'signed_in' }).r, buildAdminActor({ active: false })),
    ).resolves.toBeUndefined();
    await expect(
      enforceActorRouteAccess(req({ access: 'self' }).r, buildAdminActor({ active: false })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('exportRouteTable', () => {
  afterEach(() => _resetDeclaredRoutes());

  it('is empty before any route is registered', () => {
    _resetDeclaredRoutes();
    expect(exportRouteTable()).toEqual({
      version: 1,
      unchecked_prefixes: ['/api/reference', '/documentation'],
      routes: [],
    });
  });

  it('exports each declared route with its method, path template and declaration, sorted', () => {
    _resetDeclaredRoutes();
    assertRouteDeclared(route({ access: 'public' }, 'GET', '/v1/b'));
    assertRouteDeclared(route({ capability: 'org.manage', strict: true }, 'POST', '/v1/a/:id'));
    assertRouteDeclared(
      route({ anyCapability: ['org.manage', 'orgs.onboard'] }, ['GET', 'HEAD'], '/v1/a'),
    );
    expect(exportRouteTable().routes).toEqual([
      { method: 'GET', path: '/v1/a', access: { anyCapability: ['org.manage', 'orgs.onboard'] } },
      { method: 'GET', path: '/v1/b', access: { access: 'public' } },
      { method: 'POST', path: '/v1/a/:id', access: { capability: 'org.manage', strict: true } },
    ]);
  });

  it('leaves plugin routes out (they carry no declaration)', () => {
    _resetDeclaredRoutes();
    assertRouteDeclared(route(undefined, 'GET', '/documentation/json'));
    expect(exportRouteTable().routes).toEqual([]);
  });
});

describe('declared route table', () => {
  // Building the app runs the boot check on every route; this snapshot makes
  // any change to a route's access visible in review (#805). Built with the
  // CUSTOM-ROLES flag on so the full surface — including the authoring routes
  // that are omitted when it is off — stays visible here; their conditional
  // registration is covered by the v1-console route tests.
  /** One label per declaration: its capability, any-of list, or access kind. */
  const routeAccessLabel = (d: RouteAccess): string => {
    if ('capability' in d) return `${d.capability}${d.strict ? ' (strict)' : ''}`;
    if ('anyCapability' in d) return d.anyCapability.join('|');
    return d.access;
  };

  it('declares every route of the app', async () => {
    const prev = config.RBAC_CUSTOM_ROLES_ENABLED;
    config.RBAC_CUSTOM_ROLES_ENABLED = true;
    _resetDeclaredRoutes();
    const app = await buildApp();
    await app.ready();
    await app.close();
    config.RBAC_CUSTOM_ROLES_ENABLED = prev;
    const table = Object.fromEntries(
      listDeclaredRoutes().map(([k, d]) => [k, routeAccessLabel(d)]),
    );
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(45);
    expect(table).toMatchSnapshot();
  });

  // The catalogue deliberately runs ahead of the routes. Pinning the set keeps
  // that visible: adding the missing route drops a capability from this list
  // and the console stops marking it "not enforced yet" on its own.
  it('names the capabilities nothing enforces yet', async () => {
    const prev = config.RBAC_CUSTOM_ROLES_ENABLED;
    config.RBAC_CUSTOM_ROLES_ENABLED = true;
    _resetDeclaredRoutes();
    const app = await buildApp();
    await app.ready();
    await app.close();
    config.RBAC_CUSTOM_ROLES_ENABLED = prev;

    const enforced = enforcedCapabilities();
    const reserved = CAPABILITIES.filter((c) => !enforced.has(c));

    expect([...reserved].sort()).toEqual([
      'agreement.manage',
      'orgs.block',
      'profiles.act_on_behalf',
      'profiles.move',
      'profiles.retire',
      'profiles.verify',
    ]);
    // Checked inside a handler, not declared on a route — still enforced.
    expect(enforced.has('contact.unmask')).toBe(true);
  });
});
