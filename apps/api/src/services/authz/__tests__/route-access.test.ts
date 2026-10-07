/**
 * Unit tests for route access declarations (`@aggregator-dpg/api`, RBAC R1):
 * the boot check, the per-route enforcement, and the declared route table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest, RouteOptions } from 'fastify';
import { join } from 'node:path';
import { loadRbacConfig } from '@aggregator-dpg/rbac';
import { AuthorizerFake } from '@aggregator-dpg/rbac/testing';
import { buildApp } from '../../../app.js';
import {
  assertRouteDeclared,
  enforceRouteAccess,
  isServiceAccount,
  listDeclaredRoutes,
  _resetDeclaredRoutes,
  type RouteAccess,
} from '../route-access.js';
import { _setRbacRuntime } from '../runtime.js';
import { InMemoryActorResolver, _setActorResolver } from '../actor-resolver/index.js';

const { config: cfg } = await loadRbacConfig([join(process.env.CONFIG_ROOT ?? '', 'rbac.yaml')]);

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
  _setRbacRuntime({ mode, config: cfg, authorizer: new AuthorizerFake() });
  const resolver = new InMemoryActorResolver();
  resolver.seed({
    userId: 'u1',
    userType: 'coordinator',
    active,
    orgs: [{ id: 'org-a', orgType: 'aggregator', relation: 'member', permissionSet: null }],
    grants: [],
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

describe('declared route table', () => {
  // Building the app runs the boot check on every route; this snapshot makes
  // any change to a route's access visible in review (#805).
  it('declares every route of the app', async () => {
    _resetDeclaredRoutes();
    const app = await buildApp();
    await app.ready();
    await app.close();
    const table = Object.fromEntries(
      listDeclaredRoutes().map(([k, d]) => [k, 'capability' in d ? d.capability : d.access]),
    );
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(45);
    expect(table).toMatchSnapshot();
  });
});
