/**
 * Route tests for `GET /v1/user/consent/status` and `POST /v1/user/consent`
 * (`@aggregator-dpg/api`): the snake_case wire shapes, the signed-in
 * requirement and the error mapping. The services are replaced through their
 * test seams.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { BaseError, DomainError } from '@aggregator-dpg/shared-primitives/errors';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import {
  ActorResolverFake,
  buildAdminActor,
  buildCoordinatorActor,
  _setActorResolver,
  type Actor,
} from '../services/auth/actor/index.js';
import { _setConsentStatusReader } from '../services/consent-status.js';
import { _setConsentAcceptor } from '../services/consent-accept.js';

const ORG_B = '00000000-0000-4000-8000-00000000000b';

describe('GET /v1/user/consent/status', () => {
  let app: FastifyInstance;
  let seen: Actor | null;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';
    _setAccessTokenVerifier(async (token) => {
      if (token === 'coord-token') return { sub: 'c-sub', aggregator_id: 'agg-1' };
      if (token === 'owner-token') return { sub: 'owner-sub' };
      throw new Error('invalid token');
    });
    const resolver = new ActorResolverFake();
    resolver.seed('agg-1', buildCoordinatorActor());
    resolver.seed('owner-sub', buildAdminActor());
    _setActorResolver(resolver);
    seen = null;
    _setConsentStatusReader(async (actor) => {
      seen = actor;
      return actor.userType === 'coordinator'
        ? ok({
            outstanding: false,
            audience: 'aggregator',
            termsVersion: 3,
            privacyVersion: 2,
            outstandingOrgIds: [],
          })
        : ok({
            outstanding: true,
            audience: 'org',
            termsVersion: 4,
            privacyVersion: 5,
            outstandingOrgIds: [ORG_B],
          });
    });
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setActorResolver(null);
    _setConsentStatusReader(null);
  });

  it('answers a coordinator with the snake_case status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/user/consent/status',
      headers: { authorization: 'Bearer coord-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      outstanding: false,
      audience: 'aggregator',
      terms_version: 3,
      privacy_version: 2,
      org_ids: [],
    });
    expect(seen?.userType).toBe('coordinator');
  });

  it('answers an owner with the orgs still to accept', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/user/consent/status',
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      outstanding: true,
      audience: 'org',
      terms_version: 4,
      privacy_version: 5,
      org_ids: [ORG_B],
    });
  });

  it('refuses a request without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/user/consent/status' });
    expect(res.statusCode).toBe(401);
    expect(seen).toBeNull();
  });

  it('answers 503 when the status read fails on the database', async () => {
    _setConsentStatusReader(async () =>
      err(new BaseError('DB_UNAVAILABLE', 'consent_record read failed')),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/user/consent/status',
      headers: { authorization: 'Bearer coord-token' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'DB_UNAVAILABLE' } });
  });
});

describe('POST /v1/user/consent', () => {
  let app: FastifyInstance;
  let seen: { actor: Actor; shown: { termsVersion: number; privacyVersion: number } } | null;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';
    _setAccessTokenVerifier(async (token) => {
      if (token === 'coord-token') return { sub: 'c-sub', aggregator_id: 'agg-1' };
      throw new Error('invalid token');
    });
    const resolver = new ActorResolverFake();
    resolver.seed('agg-1', buildCoordinatorActor());
    _setActorResolver(resolver);
    seen = null;
    _setConsentAcceptor(async (actor, shown) => {
      seen = { actor, shown };
      return ok({ recorded: 1 });
    });
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setActorResolver(null);
    _setConsentAcceptor(null);
  });

  const post = (payload: Record<string, unknown>, token: string | null = 'coord-token') =>
    app.inject({
      method: 'POST',
      url: '/v1/user/consent',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    });

  it('records the shown versions and answers the count', async () => {
    const res = await post({ terms_version: 3, privacy_version: 2 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recorded: 1 });
    expect(seen?.actor.userType).toBe('coordinator');
    expect(seen?.shown).toEqual({ termsVersion: 3, privacyVersion: 2 });
  });

  it('answers 409 when the versions changed', async () => {
    _setConsentAcceptor(async () =>
      err(new DomainError('stale', { code: 'CONSENT_VERSION_CHANGED' })),
    );
    const res = await post({ terms_version: 3, privacy_version: 2 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'CONSENT_VERSION_CHANGED' } });
  });

  it('answers 503 when the write fails on the database', async () => {
    _setConsentAcceptor(async () => err(new BaseError('DB_UNAVAILABLE', 'write failed')));
    const res = await post({ terms_version: 3, privacy_version: 2 });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'DB_UNAVAILABLE' } });
  });

  it('answers 500 when the consent config cannot be read', async () => {
    _setConsentAcceptor(async () =>
      err(new BaseError('CONSENT_CONFIG_UNAVAILABLE', 'config down')),
    );
    const res = await post({ terms_version: 3, privacy_version: 2 });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'INTERNAL' } });
  });

  it('refuses a version below 1', async () => {
    const res = await post({ terms_version: 0, privacy_version: 2 });
    expect(res.statusCode).toBe(400);
    expect(seen).toBeNull();
  });

  it('refuses a body without the versions', async () => {
    const res = await post({});
    expect(res.statusCode).toBe(400);
    expect(seen).toBeNull();
  });

  it('refuses a request without a token', async () => {
    const res = await post({ terms_version: 3, privacy_version: 2 }, null);
    expect(res.statusCode).toBe(401);
    expect(seen).toBeNull();
  });
});
