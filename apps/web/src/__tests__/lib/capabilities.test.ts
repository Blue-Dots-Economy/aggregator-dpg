import { describe, expect, it } from 'vitest';
import { can, canManageOrg } from '@/lib/capabilities';

describe('can', () => {
  it('allows everything when access control is off', () => {
    expect(can(null, 'profiles.view_pii')).toBe(true);
    expect(can(undefined, 'org.manage')).toBe(true);
  });

  it('allows only listed capabilities otherwise', () => {
    expect(can(['profiles.view'], 'profiles.view')).toBe(true);
    expect(can(['profiles.view'], 'profiles.view_pii')).toBe(false);
    expect(can([], 'profiles.view')).toBe(false);
  });
});

describe('canManageOrg', () => {
  const root = { id: 'root', org_type: 'network_facilitator' };
  const owned = { id: 'own', org_type: 'aggregator', capabilities: ['org.manage'] };

  it('allows every organisation when access control is off', () => {
    expect(canManageOrg({ capabilities: null, orgs: [] }, 'any')).toBe(true);
  });

  it('allows only organisations where org.manage is held', () => {
    const me = {
      capabilities: ['org.manage'],
      orgs: [{ ...root, capabilities: ['orgs.onboard'] }, owned],
    };
    expect(canManageOrg(me, 'own')).toBe(true);
    expect(canManageOrg(me, 'other')).toBe(false);
  });

  it('allows every organisation when org.manage is held in the root', () => {
    const me = { capabilities: ['org.manage'], orgs: [{ ...root, capabilities: ['org.manage'] }] };
    expect(canManageOrg(me, 'other')).toBe(true);
  });

  it('treats missing per-organisation capabilities as not held', () => {
    expect(
      canManageOrg({ capabilities: [], orgs: [{ id: 'own', org_type: 'aggregator' }] }, 'own'),
    ).toBe(false);
  });
});
