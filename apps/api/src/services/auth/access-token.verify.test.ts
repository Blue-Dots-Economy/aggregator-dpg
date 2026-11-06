/**
 * Tests for the client-scoping controls added to token verification:
 * the `azp` allow-list gate (`KEYCLOAK_ALLOWED_AZP`) applied on both the
 * user (`authenticate`) and service (`authenticateAny`) paths.
 *
 * `aud` validation is delegated to jose's `jwtVerify` (exercised only with a
 * real signed token + JWKS) and so is not covered here — these tests drive the
 * post-verify `azp` gate via the test verifier override.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { authenticate, authenticateAny, _setAccessTokenVerifier } from './access-token.js';
import type { FastifyRequest } from 'fastify';

const aggregatorId = '11111111-1111-1111-1111-111111111111';

function makeReq(claims: Record<string, unknown>): FastifyRequest {
  _setAccessTokenVerifier(async () => claims);
  return { headers: { authorization: 'Bearer stub' } } as unknown as FastifyRequest;
}

afterEach(() => {
  _setAccessTokenVerifier(null);
  delete process.env.KEYCLOAK_ALLOWED_AZP;
});

describe('azp allow-list gate', () => {
  it('is disabled when KEYCLOAK_ALLOWED_AZP is unset (any azp passes)', async () => {
    const req = makeReq({ sub: 'service-account-x', azp: 'some-unknown-client' });
    const result = await authenticateAny(req);
    expect(result.ok).toBe(true);
  });

  it('accepts a token whose azp is in the allow-list', async () => {
    process.env.KEYCLOAK_ALLOWED_AZP = 'aggregator-portal, aggregator-api';
    const req = makeReq({ sub: 'service-account-x', azp: 'aggregator-api' });
    const result = await authenticateAny(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.authorizedParty).toBe('aggregator-api');
  });

  it('rejects a token whose azp is not in the allow-list', async () => {
    process.env.KEYCLOAK_ALLOWED_AZP = 'aggregator-portal,aggregator-api';
    const req = makeReq({ sub: 'service-account-x', azp: 'attacker-client' });
    const result = await authenticateAny(req);
    expect(result.ok).toBe(false);
    // #692: authenticateAny now surfaces a distinct AZP_NOT_ALLOWED code so
    // callers can map a wrong-client token to 403 while a bad signature stays
    // 401 — see AzpNotAllowedError. authenticate() (the user path, below)
    // keeps the prior INVALID_TOKEN mapping unchanged.
    if (!result.ok) expect(result.error.code).toBe('AZP_NOT_ALLOWED');
  });

  it('rejects a token with no azp when the allow-list is configured', async () => {
    process.env.KEYCLOAK_ALLOWED_AZP = 'aggregator-api';
    const req = makeReq({ sub: 'service-account-x' });
    const result = await authenticateAny(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AZP_NOT_ALLOWED');
  });

  it('also gates the user path (authenticate): disallowed azp is rejected before aggregator_id is read', async () => {
    process.env.KEYCLOAK_ALLOWED_AZP = 'aggregator-portal';
    const req = makeReq({ sub: 'user-1', aggregator_id: aggregatorId, azp: 'attacker-client' });
    const result = await authenticate(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TOKEN');
  });

  it('allows the user path when azp is permitted', async () => {
    process.env.KEYCLOAK_ALLOWED_AZP = 'aggregator-portal';
    const req = makeReq({ sub: 'user-1', aggregator_id: aggregatorId, azp: 'aggregator-portal' });
    const result = await authenticate(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.aggregatorId).toBe(aggregatorId);
  });
});

describe('claim reading', () => {
  it('authenticate copies the optional claims onto the context', async () => {
    const req = makeReq({
      sub: 'user-1',
      aggregator_id: [aggregatorId],
      email: 'asha@example.org',
      email_verified: true,
      preferred_username: 'asha',
      azp: 'aggregator-portal',
      given_name: 'Asha',
      family_name: 'Rao',
      phone_number: ['9876543210'],
      phone_number_verified: 'true',
      decision_made: ['approved'],
      aggregator_type: 'skilling',
      signalstack_org_id: 'ss-1',
    });
    const result = await authenticate(req);
    expect(result).toEqual({
      ok: true,
      context: {
        userId: 'user-1',
        aggregatorId,
        email: 'asha@example.org',
        emailVerified: true,
        preferredUsername: 'asha',
        azp: 'aggregator-portal',
        firstName: 'Asha',
        lastName: 'Rao',
        phoneNumber: '9876543210',
        phoneNumberVerified: true,
        decisionMade: 'approved',
        aggregatorType: 'skilling',
        signalstackOrgId: 'ss-1',
      },
    });
  });

  it('authenticate ignores claims of the wrong type', async () => {
    const req = makeReq({
      sub: 'user-1',
      aggregator_id: aggregatorId,
      email: 5,
      email_verified: 'yes',
      azp: ['x'],
      decision_made: 'maybe',
      phoneNumberVerified: false,
    });
    const result = await authenticate(req);
    expect(result).toEqual({
      ok: true,
      context: { userId: 'user-1', aggregatorId, phoneNumberVerified: false },
    });
  });

  it('authenticate refuses a token with an empty or non-string aggregator_id', async () => {
    for (const aggregator_id of ['', [5], undefined]) {
      const result = await authenticate(makeReq({ sub: 'user-1', aggregator_id }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('MISSING_AGGREGATOR_ID');
    }
  });

  it('authenticateAny copies the service claims and marks a user token', async () => {
    const result = await authenticateAny(
      makeReq({
        sub: 'user-1',
        aggregator_id: aggregatorId,
        azp: 'aggregator-bff',
        client_id: 'aggregator-bff',
        preferred_username: 'service-account-aggregator-bff',
        email: 'svc@example.org',
      }),
    );
    expect(result).toEqual({
      ok: true,
      context: {
        subject: 'user-1',
        isUser: true,
        authorizedParty: 'aggregator-bff',
        clientId: 'aggregator-bff',
        preferredUsername: 'service-account-aggregator-bff',
        aggregatorId,
        email: 'svc@example.org',
      },
    });
  });
});
