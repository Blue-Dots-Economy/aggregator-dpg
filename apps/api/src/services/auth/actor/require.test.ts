/**
 * Unit tests for the console route guard `requireActor`.
 *
 * Drives token verification with `_setAccessTokenVerifier` and pins the
 * resolved caller with the `ActorResolverFake`, so every rejection branch
 * (missing/bad token, wrong client, service account, unprovisioned, not
 * approved, coordinator on an admin route, admin without an active org, store
 * failure) and the two admit paths are exercised without a live Keycloak.
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { _setAccessTokenVerifier } from '../access-token.js';
import { HttpError } from '../../../errors/http-error.js';
import { ActorResolverFake, buildAdminActor, _setActorResolver } from './index.js';
import { requireActor } from './require.js';
import { ACTING_ACCOUNT_HEADER } from '@aggregator-dpg/shared-primitives/user-org';

const SUBJECT = 'kc-sub-1';

function reqWithClaims(claims: Record<string, unknown>): FastifyRequest {
  _setAccessTokenVerifier(async () => claims);
  return { headers: { authorization: 'Bearer stub' } } as unknown as FastifyRequest;
}

async function expectHttp(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e) => e instanceof HttpError && e.code === code);
}

describe('requireActor', () => {
  let resolver: ActorResolverFake;

  beforeEach(() => {
    delete process.env.KEYCLOAK_ALLOWED_AZP;
    resolver = new ActorResolverFake();
    _setActorResolver(resolver);
  });

  afterEach(() => {
    _setAccessTokenVerifier(null);
    _setActorResolver(null);
    delete process.env.KEYCLOAK_ALLOWED_AZP;
  });

  it('UNAUTHORIZED when no Bearer token is present', async () => {
    const req = { headers: {} } as unknown as FastifyRequest;
    await expectHttp(requireActor(req), 'UNAUTHORIZED');
  });

  it('FORBIDDEN when the token client is not allow-listed', async () => {
    process.env.KEYCLOAK_ALLOWED_AZP = 'aggregator-portal';
    const req = reqWithClaims({ sub: SUBJECT, azp: 'some-other-client' });
    await expectHttp(requireActor(req), 'FORBIDDEN');
  });

  it('FORBIDDEN for a service-account token', async () => {
    const req = reqWithClaims({
      sub: SUBJECT,
      preferred_username: 'service-account-aggregator-bff',
    });
    await expectHttp(requireActor(req), 'FORBIDDEN');
  });

  it('DB_UNAVAILABLE when the actor resolver fails', async () => {
    resolver.failWith = 'store down';
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'asha' });
    await expectHttp(requireActor(req), 'DB_UNAVAILABLE');
  });

  it('USER_NOT_PROVISIONED when the token maps to no account', async () => {
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'asha' });
    await expectHttp(requireActor(req), 'USER_NOT_PROVISIONED');
  });

  it('NOT_APPROVED for a coordinator whose registration is not active', async () => {
    resolver.seed(SUBJECT, {
      userId: 'c1',
      userType: 'coordinator',
      active: false,
      orgs: [],
    });
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'asha' });
    await expectHttp(requireActor(req, { allowCoordinator: true }), 'NOT_APPROVED');
  });

  it('FORBIDDEN for an approved coordinator on an admin-only route', async () => {
    resolver.seed(SUBJECT, { userId: 'c1', userType: 'coordinator', active: true, orgs: [] });
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'asha' });
    await expectHttp(requireActor(req), 'FORBIDDEN');
  });

  it('admits an approved coordinator when allowCoordinator is set', async () => {
    const actor = { userId: 'c1', userType: 'coordinator' as const, active: true, orgs: [] };
    resolver.seed(SUBJECT, actor);
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'asha' });
    const caller = await requireActor(req, { allowCoordinator: true });
    expect(caller.actor).toEqual(actor);
    expect(caller.auth.subject).toBe(SUBJECT);
  });

  it('NOT_ORG_ADMIN for an admin owning no active org', async () => {
    resolver.seed(SUBJECT, buildAdminActor({ active: false, orgs: [] }));
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'owner' });
    await expectHttp(requireActor(req), 'NOT_ORG_ADMIN');
  });

  it('admits an admin owning an active org', async () => {
    resolver.seed(SUBJECT, buildAdminActor());
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'owner' });
    const caller = await requireActor(req);
    expect(caller.actor.userType).toBe('admin');
  });

  it('passes an user_id claim through to the resolver', async () => {
    const actor = { userId: 'c1', userType: 'coordinator' as const, active: true, orgs: [] };
    resolver.seed('agg-99', actor);
    const req = reqWithClaims({
      sub: SUBJECT,
      user_id: 'agg-99',
      preferred_username: 'asha',
    });
    const caller = await requireActor(req, { allowCoordinator: true });
    expect(caller.actor).toEqual(actor);
  });
  describe('x-acting-account header', () => {
    const ACTING = '00000000-0000-4000-8000-0000000000c1';

    function reqActing(value: string): FastifyRequest {
      _setAccessTokenVerifier(async () => ({ sub: SUBJECT, preferred_username: 'owner' }));
      return {
        headers: { authorization: 'Bearer stub', [ACTING_ACCOUNT_HEADER]: value },
      } as unknown as FastifyRequest;
    }

    it('passes the acting account to the resolver', async () => {
      const actor = { userId: ACTING, userType: 'coordinator' as const, active: true, orgs: [] };
      resolver.seed(ACTING, actor);
      const caller = await requireActor(reqActing(ACTING), { allowCoordinator: true });
      expect(caller.actor).toEqual(actor);
    });

    it('FORBIDDEN on an admin-only route: the acting actor is a coordinator', async () => {
      resolver.seed(ACTING, { userId: ACTING, userType: 'coordinator', active: true, orgs: [] });
      await expectHttp(requireActor(reqActing(ACTING)), 'FORBIDDEN');
    });

    it('ACTING_ACCOUNT_INVALID for a malformed header value', async () => {
      await expectHttp(requireActor(reqActing('nope')), 'ACTING_ACCOUNT_INVALID');
    });

    it('ACTING_ACCOUNT_INVALID when the resolver refuses the account', async () => {
      resolver.resolve = async () => ({
        ok: false,
        error: { code: 'ACTING_ACCOUNT_INVALID', message: 'not linked' },
      });
      await expect(requireActor(reqActing(ACTING), { allowCoordinator: true })).rejects.toSatisfy(
        (e) =>
          e instanceof HttpError &&
          e.code === 'ACTING_ACCOUNT_INVALID' &&
          e.message === 'acting account not usable',
      );
    });
  });
});
