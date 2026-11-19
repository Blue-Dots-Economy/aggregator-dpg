import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTING_ROLE_PREFIX, actingRoleEntry, parseActingRoleEntry } from '../acting.js';

describe('acting role entries', () => {
  it('builds acting:<account>:<role>', () => {
    expect(ACTING_ROLE_PREFIX).toBe('acting:');
    expect(actingRoleEntry('u1', 'coordinator')).toBe('acting:u1:coordinator');
  });

  it('round-trips', () => {
    expect(parseActingRoleEntry(actingRoleEntry('u1', 'coordinator'))).toEqual({
      accountId: 'u1',
      roleKey: 'coordinator',
    });
  });

  it('returns null for a plain role key and for malformed entries', () => {
    expect(parseActingRoleEntry('org_admin')).toBeNull();
    expect(parseActingRoleEntry('acting:u1')).toBeNull();
    expect(parseActingRoleEntry('acting::coordinator')).toBeNull();
    expect(parseActingRoleEntry('acting:u1:')).toBeNull();
  });

  it('matches the prefix the edge policy uses', () => {
    const edge = readFileSync(
      fileURLToPath(new URL('../../../../policy/rbac/edge.rego', import.meta.url)),
      'utf8',
    );
    expect(edge).toContain(`acting_prefix := "${ACTING_ROLE_PREFIX}"`);
  });
});
