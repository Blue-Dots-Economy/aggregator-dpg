import { describe, expect, it } from 'vitest';
import { can, canInvite, canManageOrg, canViewCoordinators } from '@/lib/capabilities';

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

  it('with access control off, allows the network admin everywhere and an owner its own orgs', () => {
    expect(canManageOrg({ capabilities: null, orgs: [root] }, 'any')).toBe(true);
    expect(canManageOrg({ capabilities: null, orgs: [owned] }, 'own')).toBe(true);
    // An org below the owner's own is only viewed.
    expect(canManageOrg({ capabilities: null, orgs: [owned] }, 'below')).toBe(false);
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

describe('canInvite', () => {
  const root = { id: 'root', org_type: 'network_facilitator' };
  const dflt = {
    id: 'dflt',
    org_type: 'aggregator',
    is_default: true,
    capabilities: ['org.manage'],
  };
  const real = {
    id: 'real',
    org_type: 'aggregator',
    is_default: false,
    capabilities: ['org.manage'],
  };

  it('is offered when access control is off', () => {
    expect(canInvite({ capabilities: null, orgs: [] })).toBe(true);
  });

  it('is not offered to a network admin that manages only the Default org', () => {
    const me = {
      capabilities: ['org.manage'],
      orgs: [{ ...root, capabilities: ['orgs.onboard'] }, dflt],
    };
    expect(canInvite(me)).toBe(false);
  });

  it('is offered for a managed org that takes invites, or org.manage in the root', () => {
    expect(canInvite({ capabilities: ['org.manage'], orgs: [real] })).toBe(true);
    expect(
      canInvite({
        capabilities: ['org.manage'],
        orgs: [{ ...root, capabilities: ['org.manage'] }],
      }),
    ).toBe(true);
  });
});

describe('canViewCoordinators', () => {
  it('admits an org admin or the network admin, not others', () => {
    expect(canViewCoordinators({ capabilities: ['org.manage'], orgs: [] })).toBe(true);
    expect(canViewCoordinators({ capabilities: ['network.administer'], orgs: [] })).toBe(true);
    expect(canViewCoordinators({ capabilities: ['profiles.view'], orgs: [] })).toBe(false);
    expect(canViewCoordinators({ capabilities: null, orgs: [] })).toBe(true);
  });
});
