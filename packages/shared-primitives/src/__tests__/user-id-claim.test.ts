/**
 * Tests for reading the user id from an access token's claims.
 */

import { describe, expect, it } from 'vitest';
import { readUserIdClaim } from '../user-id-claim/index.js';

const ID = '3c55d7ab-a00b-49b8-89f7-8a624b986d0c';
const OTHER = '11111111-1111-4111-8111-111111111111';

describe('readUserIdClaim', () => {
  it('reads a token that carries user_id', () => {
    expect(readUserIdClaim({ user_id: ID })).toEqual({ kind: 'present', userId: ID });
  });

  it('reads a claim published as a one-element list', () => {
    expect(readUserIdClaim({ user_id: [ID] })).toEqual({ kind: 'present', userId: ID });
  });

  it('ignores aggregator_id', () => {
    expect(readUserIdClaim({ aggregator_id: ID })).toEqual({ kind: 'absent' });
    expect(readUserIdClaim({ user_id: ID, aggregator_id: OTHER })).toEqual({
      kind: 'present',
      userId: ID,
    });
  });

  it('treats a missing, empty or non-string claim as absent', () => {
    expect(readUserIdClaim({})).toEqual({ kind: 'absent' });
    expect(readUserIdClaim(null)).toEqual({ kind: 'absent' });
    expect(readUserIdClaim(undefined)).toEqual({ kind: 'absent' });
    expect(readUserIdClaim({ user_id: '' })).toEqual({ kind: 'absent' });
    expect(readUserIdClaim({ user_id: [] })).toEqual({ kind: 'absent' });
    expect(readUserIdClaim({ user_id: 42 })).toEqual({ kind: 'absent' });
  });
});
