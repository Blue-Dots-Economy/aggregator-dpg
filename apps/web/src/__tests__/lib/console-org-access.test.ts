import { describe, it, expect } from 'vitest';
import type { MeResponse, OrgReadResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { orgPageAccess } from '@/lib/console-org-access';

type Org = OrgReadResponse['org'];

function me(over: Partial<MeResponse> = {}): MeResponse {
  return {
    kind: 'admin',
    user: { id: 'u1', contact: { name: 'Owner', email: 'o@example.org', phone: null } },
    orgs: [],
    is_network_admin: false,
    capabilities: [],
    ...over,
  } as MeResponse;
}

function org(over: Partial<Org> = {}): Org {
  return {
    id: 'org-a',
    org_type: 'aggregator',
    is_default: false,
    status: 'active',
    ...over,
  } as Org;
}

const admin = me({ is_network_admin: true, capabilities: ['network.administer', 'orgs.onboard'] });
const ownerOfA = me({
  orgs: [
    { id: 'org-a', name: 'A', slug: 'a', org_type: 'aggregator', role: 'owner', is_default: false },
  ],
  capabilities: ['org.manage'],
});

describe('orgPageAccess', () => {
  it('gives the network admin every action on an active org', () => {
    const a = orgPageAccess(admin, org());
    expect(a).toMatchObject({
      own: true,
      editable: true,
      canRename: true,
      canAssignOwner: true,
      canRepair: true,
      movable: true,
      canDecide: false,
      listsChildren: true,
    });
  });

  it('lets the owner edit its own org, without the admin actions', () => {
    const a = orgPageAccess(ownerOfA, org());
    expect(a).toMatchObject({
      own: true,
      editable: true,
      canRename: false,
      canAssignOwner: false,
      canRepair: false,
    });
  });

  it('shows an org below the owner as view-only', () => {
    const a = orgPageAccess(ownerOfA, org({ id: 'org-below' }));
    expect(a.own).toBe(false);
    expect(a.editable).toBe(false);
    expect(a.movable).toBe(false);
  });

  it('never edits, moves or lists children of the Default org', () => {
    const a = orgPageAccess(admin, org({ is_default: true }));
    expect(a).toMatchObject({
      editable: false,
      movable: false,
      listsChildren: false,
      canRepair: false,
    });
  });

  it('offers the decision on a pending org only with orgs.onboard', () => {
    expect(orgPageAccess(admin, org({ status: 'pending' })).canDecide).toBe(true);
    expect(orgPageAccess(ownerOfA, org({ status: 'pending' })).canDecide).toBe(false);
  });

  it('does not move or repair a rejected org', () => {
    const a = orgPageAccess(admin, org({ status: 'rejected' }));
    expect(a.movable).toBe(false);
    expect(a.canRepair).toBe(false);
  });

  it('treats the root as not editable and without children listed', () => {
    const a = orgPageAccess(admin, org({ org_type: 'network_facilitator' }));
    expect(a).toMatchObject({ editable: false, listsChildren: false, canAssignOwner: false });
  });
});
