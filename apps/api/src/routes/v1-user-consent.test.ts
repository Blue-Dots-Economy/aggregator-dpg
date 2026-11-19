/**
 * Route tests for `GET /v1/user/consent/status` (`@aggregator-dpg/api`): the
 * snake_case wire shape and the signed-in requirement. The status service is
 * replaced through its test seam.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { BaseError } from '@aggregator-dpg/shared-primitives/errors';
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
