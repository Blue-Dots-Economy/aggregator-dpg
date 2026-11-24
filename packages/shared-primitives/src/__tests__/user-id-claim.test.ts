/**
 * Tests for reading the user id from an access token's claims.
 */

import { describe, expect, it } from 'vitest';
import { readUserIdClaim } from '../user-id-claim/index.js';

const ID = '3c55d7ab-a00b-49b8-89f7-8a624b986d0c';
const OTHER = '11111111-1111-4111-8111-111111111111';

describe('readUserIdClaim', () => {
  it('reads an old token that carries only aggregator_id', () => {
    expect(readUserIdClaim({ aggregator_id: ID })).toEqual({ kind: 'present', userId: ID });
  });

  it('reads a new token that carries only user_id', () => {
    expect(readUserIdClaim({ user_id: ID })).toEqual({ kind: 'present', userId: ID });
  });

  it('reads a token that carries both with the same value', () => {
    expect(readUserIdClaim({ user_id: ID, aggregator_id: ID })).toEqual({
      kind: 'present',
      userId: ID,
    });
  });

  it('reports a mismatch when the two claims disagree', () => {
    expect(readUserIdClaim({ user_id: ID, aggregator_id: OTHER })).toEqual({ kind: 'mismatch' });
  });

  it('reads a claim published as a one-element list', () => {
    expect(readUserIdClaim({ user_id: [ID], aggregator_id: [ID] })).toEqual({
      kind: 'present',
      userId: ID,
    });
    expect(readUserIdClaim({ user_id: [ID], aggregator_id: [OTHER] })).toEqual({
      kind: 'mismatch',
    });
  });

  it('treats a missing, empty or non-string claim as absent', () => {
    expect(readUserIdClaim({})).toEqual({ kind: 'absent' });
    expect(readUserIdClaim(null)).toEqual({ kind: 'absent' });
    expect(readUserIdClaim(undefined)).toEqual({ kind: 'absent' });
    expect(readUserIdClaim({ user_id: '', aggregator_id: [] })).toEqual({ kind: 'absent' });
    expect(readUserIdClaim({ user_id: 42, aggregator_id: [7] })).toEqual({ kind: 'absent' });
  });

  it('falls back to aggregator_id when user_id is empty', () => {
    expect(readUserIdClaim({ user_id: '', aggregator_id: ID })).toEqual({
      kind: 'present',
      userId: ID,
    });
  });
});
