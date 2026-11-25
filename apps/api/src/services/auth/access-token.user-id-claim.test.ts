/**
 * Unit tests: every auth path reads the user id from the `user_id` claim only
 * (`@aggregator-dpg/api`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  _setAccessTokenVerifier,
  authenticate,
  authenticateAllowingActing,
  authenticateAny,
} from './access-token.js';

const SUB = 'kc-sub-1';
const ID = '3c55d7ab-a00b-49b8-89f7-8a624b986d0c';
const OTHER = '11111111-1111-4111-8111-111111111111';

function makeReq(claims: Record<string, unknown>): FastifyRequest {
  _setAccessTokenVerifier(async () => ({ sub: SUB, ...claims }));
  return { headers: { authorization: 'Bearer stub' } } as unknown as FastifyRequest;
}

/** A token that still carries the former claim name and no `user_id`. */
const FORMER_ONLY = { aggregator_id: ID };

afterEach(() => {
  _setAccessTokenVerifier(null);
});

describe('authenticate', () => {
  it('reads the user id from user_id', async () => {
    const res = await authenticate(makeReq({ user_id: ID }));
    expect(res.ok && res.context.userId).toBe(ID);
  });

  it('ignores aggregator_id when user_id is present', async () => {
    const res = await authenticate(makeReq({ user_id: ID, aggregator_id: OTHER }));
    expect(res.ok && res.context.userId).toBe(ID);
  });

  it('reports a token with only aggregator_id as missing the id', async () => {
    const res = await authenticate(makeReq(FORMER_ONLY));
    expect(!res.ok && res.error.code).toBe('MISSING_USER_ID');
  });

  it('reports a token with no claim as missing the id', async () => {
    const res = await authenticate(makeReq({}));
    expect(!res.ok && res.error.code).toBe('MISSING_USER_ID');
  });
});

describe('authenticateAllowingActing', () => {
  it('reads the user id from user_id', async () => {
    const res = await authenticateAllowingActing(makeReq({ user_id: ID }));
    expect(res.ok && res.context.userId).toBe(ID);
  });

  it('reports a token with only aggregator_id as missing the id', async () => {
    const res = await authenticateAllowingActing(makeReq(FORMER_ONLY));
    expect(!res.ok && res.error.code).toBe('MISSING_USER_ID');
  });
});

describe('authenticateAny', () => {
  it('marks a token with user_id as a user token', async () => {
    const res = await authenticateAny(makeReq({ user_id: ID }));
    expect(res.ok && res.context).toMatchObject({ isUser: true, userId: ID });
  });

  it('treats a token with only aggregator_id as a non-user token', async () => {
    const res = await authenticateAny(makeReq(FORMER_ONLY));
    expect(res.ok && res.context.isUser).toBe(false);
  });

  it('treats a token with no claim as a non-user token', async () => {
    const res = await authenticateAny(makeReq({}));
    expect(res.ok && res.context.isUser).toBe(false);
  });
});
