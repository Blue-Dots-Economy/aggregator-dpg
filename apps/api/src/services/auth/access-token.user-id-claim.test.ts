/**
 * Unit tests: every auth path reads the user id from `user_id`, falling back to
 * `aggregator_id`, and refuses a token whose two claims differ
 * (`@aggregator-dpg/api`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  _setAccessTokenVerifier,
  authenticate,
  authenticateAllowingActing,
  authenticateAny,
} from './access-token.js';
import { logger } from '../../logger.js';

const SUB = 'kc-sub-1';
const ID = '3c55d7ab-a00b-49b8-89f7-8a624b986d0c';
const OTHER = '11111111-1111-4111-8111-111111111111';

function makeReq(claims: Record<string, unknown>): FastifyRequest {
  _setAccessTokenVerifier(async () => ({ sub: SUB, ...claims }));
  return { headers: { authorization: 'Bearer stub' } } as unknown as FastifyRequest;
}

/** The four token shapes of the rename: old claim, new claim, both equal, both different. */
const SHAPES = [
  { name: 'old token: aggregator_id only', claims: { aggregator_id: ID } },
  { name: 'new token: user_id only', claims: { user_id: ID } },
  { name: 'both claims, equal', claims: { user_id: ID, aggregator_id: ID } },
] as const;
const MISMATCH = { user_id: ID, aggregator_id: OTHER };

afterEach(() => {
  _setAccessTokenVerifier(null);
  vi.restoreAllMocks();
});

describe('authenticate', () => {
  it.each(SHAPES)('accepts the $name', async ({ claims }) => {
    const res = await authenticate(makeReq(claims));
    expect(res.ok && res.context.userId).toBe(ID);
  });

  it('refuses a token whose user_id and aggregator_id differ, as an invalid token', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const res = await authenticate(makeReq(MISMATCH));
    expect(res).toEqual({
      ok: false,
      error: { code: 'INVALID_TOKEN', message: 'token user_id and aggregator_id claims differ' },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'CLAIM_MISMATCH', sub: SUB }),
    );
  });

  it('still reports a token with neither claim as missing the id', async () => {
    const res = await authenticate(makeReq({}));
    expect(!res.ok && res.error.code).toBe('MISSING_AGGREGATOR_ID');
  });
});

describe('authenticateAllowingActing', () => {
  it.each(SHAPES)('accepts the $name', async ({ claims }) => {
    const res = await authenticateAllowingActing(makeReq(claims));
    expect(res.ok && res.context.userId).toBe(ID);
  });

  it('refuses a token whose user_id and aggregator_id differ', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const res = await authenticateAllowingActing(makeReq(MISMATCH));
    expect(!res.ok && res.error.code).toBe('INVALID_TOKEN');
  });
});

describe('authenticateAny', () => {
  it.each(SHAPES)('marks the $name as a user token', async ({ claims }) => {
    const res = await authenticateAny(makeReq(claims));
    expect(res.ok && res.context).toMatchObject({ isUser: true, userId: ID });
  });

  it('treats a token with neither claim as a non-user token', async () => {
    const res = await authenticateAny(makeReq({}));
    expect(res.ok && res.context.isUser).toBe(false);
  });

  it('refuses a token whose user_id and aggregator_id differ', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const res = await authenticateAny(makeReq(MISMATCH));
    expect(!res.ok && res.error.code).toBe('INVALID_TOKEN');
  });
});
