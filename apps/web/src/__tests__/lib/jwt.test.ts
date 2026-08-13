import { describe, it, expect } from 'vitest';
import { decodeJwtClaims, tokenAggregatorId } from '@/lib/jwt';

function makeToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('decodeJwtClaims', () => {
  it('decodes a well-formed token payload', () => {
    const token = makeToken({ sub: 'user-1', aggregator_id: 'agg-1' });
    expect(decodeJwtClaims(token)).toEqual({ sub: 'user-1', aggregator_id: 'agg-1' });
  });

  it('returns null when the token has fewer than 2 parts', () => {
    expect(decodeJwtClaims('onlyonepart')).toBeNull();
  });

  it('returns null when the payload is not valid base64url JSON', () => {
    expect(decodeJwtClaims('header.!!!notbase64orjson!!!.sig')).toBeNull();
  });
});

describe('tokenAggregatorId', () => {
  it('returns the aggregator_id claim when present and non-empty', () => {
    const token = makeToken({ aggregator_id: 'agg-42' });
    expect(tokenAggregatorId(token)).toBe('agg-42');
  });

  it('returns null when aggregator_id is absent', () => {
    const token = makeToken({ sub: 'user-1' });
    expect(tokenAggregatorId(token)).toBeNull();
  });

  it('returns null when aggregator_id is an empty string', () => {
    const token = makeToken({ aggregator_id: '' });
    expect(tokenAggregatorId(token)).toBeNull();
  });

  it('returns null when aggregator_id is not a string', () => {
    const token = makeToken({ aggregator_id: 123 });
    expect(tokenAggregatorId(token)).toBeNull();
  });

  it('returns null for a malformed token', () => {
    expect(tokenAggregatorId('garbage')).toBeNull();
  });
});
