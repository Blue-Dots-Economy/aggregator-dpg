import { describe, it, expect } from 'vitest';
import { IdpAdminFake } from '../idp-admin/testing.js';
import {
  PLACEHOLDER_OWNER_EMAIL,
  provisionRootIdp,
  rootConfigFrom,
  type RootIdpRecorder,
  type RootOrgState,
} from '../organisation-root.js';

describe('rootConfigFrom', () => {
  it('takes the legal name over the name, the first admin email, and lowercases emails', () => {
    expect(
      rootConfigFrom(
        { urlSlug: 'blue-dots', name: 'Blue Dots', legalName: 'Blue Dots Foundation' },
        ['Ops@Example.org', 'second@example.org'],
        'Default@Example.org',
      ),
    ).toEqual({
      nfSlug: 'blue-dots',
      nfName: 'Blue Dots Foundation',
      nfLegalName: 'Blue Dots Foundation',
      nfOwnerEmail: 'ops@example.org',
      defaultOwnerEmail: 'default@example.org',
    });
  });

  it('keeps everything when nothing is configured', () => {
    expect(rootConfigFrom(null, [], null)).toEqual({
      nfSlug: null,
      nfName: null,
      nfLegalName: null,
      nfOwnerEmail: null,
      defaultOwnerEmail: null,
    });
  });

  it('falls back to the name when there is no legal name', () => {
    expect(rootConfigFrom({ name: 'Net' }, [], null).nfName).toBe('Net');
  });
});

describe('provisionRootIdp', () => {
  const org = (over: Partial<RootOrgState>): RootOrgState => ({
    id: 'org-1',
    slug: 'network',
    name: 'Network',
    kcGroupId: null,
    ownerUserId: 'u-1',
    ownerEmail: 'ops@example.org',
    ownerSubject: null,
    ownerIsCoordinator: false,
    ...over,
  });

  function recorder(conflict = false) {
    const groups = new Map<string, string>();
    const subjects = new Map<string, string>();
    const r: RootIdpRecorder = {
      async setGroupId(orgId, groupId) {
        groups.set(orgId, groupId);
      },
      async linkSubject(userId, subject) {
        if (conflict) return false;
        subjects.set(userId, subject);
        return true;
      },
    };
    return { r, groups, subjects };
  }

  it('creates a group per org and a disabled user per configured owner', async () => {
    const idp = new IdpAdminFake();
    const { r, groups, subjects } = recorder();
    const report = await provisionRootIdp(
      idp,
      {
        root: org({}),
        defaultOrg: org({
          id: 'org-2',
          slug: 'default',
          name: 'Default',
          ownerUserId: 'u-2',
          ownerEmail: 'def@example.org',
        }),
      },
      r,
    );
    expect(report).toEqual({
      groupsCreated: 2,
      groupsAdopted: 0,
      usersCreated: 2,
      usersReused: 0,
      ownersRemoved: 0,
      failures: 0,
    });
    expect(idp.getGroup(groups.get('org-1')!)?.name).toBe('org-network-org-1');
    const owner = await idp.findById(subjects.get('u-1')!);
    expect(owner.ok && owner.value?.enabled).toBe(false);
    expect(idp.groupsOf(subjects.get('u-2')!)).toEqual([groups.get('org-2')]);
  });

  it('reuses an existing user untouched and skips work already done', async () => {
    const idp = new IdpAdminFake();
    const existing = await idp.createUser({ email: 'ops@example.org', enabled: true });
    if (!existing.ok) throw new Error('seed');
    const { r } = recorder();
    const report = await provisionRootIdp(
      idp,
      {
        root: org({}),
        defaultOrg: org({ id: 'org-2', slug: 'default', kcGroupId: 'g-x', ownerSubject: 'sub-x' }),
      },
      r,
    );
    expect(report.usersReused).toBe(1);
    expect(report.usersCreated).toBe(0);
    const still = await idp.findById(existing.value.id);
    expect(still.ok && still.value?.enabled).toBe(true);
  });

  it('never mirrors the placeholder owner', async () => {
    const idp = new IdpAdminFake();
    const { r, subjects } = recorder();
    const report = await provisionRootIdp(
      idp,
      {
        root: org({ ownerEmail: PLACEHOLDER_OWNER_EMAIL }),
        defaultOrg: org({ id: 'o2', slug: 'default', ownerEmail: PLACEHOLDER_OWNER_EMAIL }),
      },
      r,
    );
    expect(report.usersCreated + report.usersReused).toBe(0);
    expect(subjects.size).toBe(0);
  });

  it('counts failures and carries on (retried next boot)', async () => {
    const idp = new IdpAdminFake();
    idp.failOnce({ code: 'IDP_UNAVAILABLE', message: 'down' });
    const { r } = recorder(true);
    const report = await provisionRootIdp(
      idp,
      {
        root: org({}),
        defaultOrg: org({ id: 'o2', slug: 'default', kcGroupId: 'g', ownerSubject: 's' }),
      },
      r,
    );
    // The root's group create fails, its owner link conflicts, and adding the
    // Default owner to a group the IdP does not know fails.
    expect(report.failures).toBe(3);
  });

  it("adopts the org's own group after a 409, never another org's", async () => {
    const idp = new IdpAdminFake();
    // An earlier attempt created the root's group but its id was never stored.
    await idp.createGroup('org-network-org-1', { org_id: 'org-1' });
    // A group with the Default org's name already names another org.
    await idp.createGroup('org-default-org-2', { org_id: 'someone-else' });
    const { r, groups } = recorder();
    const report = await provisionRootIdp(
      idp,
      {
        root: org({ ownerEmail: PLACEHOLDER_OWNER_EMAIL }),
        defaultOrg: org({ id: 'org-2', slug: 'default', ownerEmail: PLACEHOLDER_OWNER_EMAIL }),
      },
      r,
    );
    expect(report.groupsAdopted).toBe(1);
    expect(groups.get('org-1')).toBeDefined();
    expect(groups.has('org-2')).toBe(false);
    expect(report.failures).toBe(1);
  });

  it('removes a replaced owner from the group, keeping its IdP user', async () => {
    const idp = new IdpAdminFake();
    const old = await idp.createUser({ email: 'old@example.org', enabled: true });
    const g = await idp.createGroup('org-network', { org_id: 'org-1' });
    if (!old.ok || !g.ok) throw new Error('seed');
    await idp.addUserToGroup(old.value.id, g.value.id);
    const { r } = recorder();
    const report = await provisionRootIdp(
      idp,
      {
        root: org({ kcGroupId: g.value.id }),
        defaultOrg: org({ id: 'org-2', slug: 'default', kcGroupId: 'g2', ownerSubject: 's' }),
        replacedOwners: [{ orgId: 'org-1', subject: old.value.id }],
      },
      r,
    );
    expect(report.ownersRemoved).toBe(1);
    expect(idp.groupsOf(old.value.id)).toEqual([]);
    const still = await idp.findById(old.value.id);
    expect(still.ok && still.value).not.toBeNull();
  });

  it("never links a coordinator's IdP user to the admin account", async () => {
    const idp = new IdpAdminFake();
    await idp.createUser({ email: 'ops@example.org', enabled: true });
    const { r, subjects } = recorder();
    const report = await provisionRootIdp(
      idp,
      {
        root: org({ ownerIsCoordinator: true }),
        defaultOrg: org({ id: 'org-2', slug: 'default', ownerIsCoordinator: true }),
      },
      r,
    );
    expect(subjects.size).toBe(0);
    expect(report.usersCreated + report.usersReused).toBe(0);
  });
});
