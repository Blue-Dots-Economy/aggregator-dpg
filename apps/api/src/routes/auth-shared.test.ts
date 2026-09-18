/**
 * Unit tests for the shared coordinator route guards.
 *
 * `services/auth/access-token.js` is mocked so the token-verification path is
 * out of scope here — what is under test is the mapping from an auth result to
 * an HTTP error code, and the invariant that the aggregator identity handed to
 * a route comes from the verified token and from nothing the client sent.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

const { authenticateMock, requireApprovedMock } = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  requireApprovedMock: vi.fn(),
}));

vi.mock('../services/auth/access-token.js', () => ({
  authenticate: authenticateMock,
  requireApproved: requireApprovedMock,
}));

import {
  enforceAggregatorType,
  requireApprovedAggregator,
  requireAuthenticatedAggregator,
} from './auth-shared.js';

/** A request whose body, query and headers all claim a DIFFERENT aggregator. */
function spoofingRequest(): FastifyRequest {
  return {
    headers: { authorization: 'Bearer t', 'x-aggregator-id': 'attacker-agg' },
    body: { aggregator_id: 'attacker-agg' },
    query: { aggregator_id: 'attacker-agg' },
    params: { aggregator_id: 'attacker-agg' },
  } as unknown as FastifyRequest;
}

const tokenContext = {
  userId: 'u-1',
  aggregatorId: 'token-agg',
  aggregatorType: 'seeker' as const,
  decisionMade: 'approved' as const,
};

describe('requireApprovedAggregator', () => {
  beforeEach(() => {
    requireApprovedMock.mockReset();
  });

  it('returns the token context, ignoring any client-supplied aggregator_id', async () => {
    requireApprovedMock.mockResolvedValue({ ok: true, context: tokenContext });
    const auth = await requireApprovedAggregator(spoofingRequest());
    // The invariant: aggregator_id comes from the verified token only.
    expect(auth.aggregatorId).toBe('token-agg');
    expect(auth).toBe(tokenContext);
  });

  it('throws NOT_APPROVED when approval is still pending', async () => {
    requireApprovedMock.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_APPROVED', message: 'aggregator approval pending' },
    });
    await expect(requireApprovedAggregator(spoofingRequest())).rejects.toMatchObject({
      code: 'NOT_APPROVED',
    });
  });

  it('throws UNAUTHORIZED for any other auth failure', async () => {
    requireApprovedMock.mockResolvedValue({
      ok: false,
      error: { code: 'MISSING_TOKEN', message: 'missing Bearer token' },
    });
    await expect(requireApprovedAggregator(spoofingRequest())).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('throws UNAUTHORIZED when a verified token carries no aggregator_id claim', async () => {
    requireApprovedMock.mockResolvedValue({
      ok: true,
      context: { ...tokenContext, aggregatorId: '' },
    });
    // A client-supplied aggregator_id must not be able to fill this gap.
    await expect(requireApprovedAggregator(spoofingRequest())).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('requireAuthenticatedAggregator', () => {
  beforeEach(() => {
    authenticateMock.mockReset();
  });

  it('returns the token context, ignoring any client-supplied aggregator_id', async () => {
    authenticateMock.mockResolvedValue({ ok: true, context: tokenContext });
    const auth = await requireAuthenticatedAggregator(spoofingRequest());
    expect(auth.aggregatorId).toBe('token-agg');
  });

  it('maps MISSING_AGGREGATOR_ID to FORBIDDEN with the reason field', async () => {
    authenticateMock.mockResolvedValue({
      ok: false,
      error: { code: 'MISSING_AGGREGATOR_ID', message: 'token has no aggregator_id claim' },
    });
    await expect(requireAuthenticatedAggregator(spoofingRequest())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      fields: { reason: 'MISSING_AGGREGATOR_ID' },
    });
  });

  it('maps every other failure to UNAUTHORIZED', async () => {
    authenticateMock.mockResolvedValue({
      ok: false,
      error: { code: 'INVALID_TOKEN', message: 'bad signature' },
    });
    await expect(requireAuthenticatedAggregator(spoofingRequest())).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      fields: { reason: 'INVALID_TOKEN' },
    });
  });
});

describe('enforceAggregatorType', () => {
  it('passes when the token type matches the requested type', () => {
    expect(() => enforceAggregatorType(tokenContext, 'seeker')).not.toThrow();
  });

  it('throws AGGREGATOR_TYPE_MISSING when the token carries no type', () => {
    const { aggregatorType: _unused, ...noType } = tokenContext;
    expect(() => enforceAggregatorType(noType, 'seeker')).toThrowError(
      expect.objectContaining({ code: 'AGGREGATOR_TYPE_MISSING' }),
    );
  });

  it('throws AGGREGATOR_TYPE_MISMATCH when the token type is a different type', () => {
    expect(() => enforceAggregatorType(tokenContext, 'provider')).toThrowError(
      expect.objectContaining({
        code: 'AGGREGATOR_TYPE_MISMATCH',
        fields: { aggregator_type: 'seeker', requested_type: 'provider' },
      }),
    );
  });
});
