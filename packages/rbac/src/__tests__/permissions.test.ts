import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { parseRbacFile } from '../roles.js';
import {
  baseRoleOf,
  effectivePermissions,
  indexRoles,
  type HeldRole,
  type Membership,
  type PermissionSubject,
} from '../permissions.js';
import { buildRole } from '../testing/index.js';

const shippedPath = fileURLToPath(new URL('../../../../config/rbac.yaml', import.meta.url));
const index = indexRoles([
  ...parseRbacFile(load(readFileSync(shippedPath, 'utf8')), 'test'),
  buildRole({
    key: 'admin_actor',
    accountType: 'admin',
    assignedBy: 'network.administer',
    permissions: ['profiles.act_on_behalf'],
  }),
]);

const NOW = 1_800_000_000_000;
const A: Membership = { orgId: 'A', orgType: 'aggregator', relation: 'member' };
const ownerOf = (orgId: string): Membership => ({
  orgId,
  orgType: 'aggregator',
  relation: 'owner',
});
const ROOT: Membership = { orgId: 'NF', orgType: 'network_facilitator', relation: 'owner' };

const coordinator = (held: HeldRole[] = []): PermissionSubject => ({
  userType: 'coordinator',
  memberships: [A],
  held,
});
const COORD = ['campaigns.run', 'profiles.onboard', 'profiles.view'];

describe('baseRoleOf', () => {
  it('maps member, aggregator owner and root owner', () => {
    expect(baseRoleOf(index, A)?.key).toBe('coordinator');
    expect(baseRoleOf(index, ownerOf('B'))?.key).toBe('org_admin');
    expect(baseRoleOf(index, ROOT)?.key).toBe('network_admin');
  });
});

describe('effectivePermissions', () => {
  it('gives a coordinator its base role in its organisation', () => {
    expect(effectivePermissions(index, coordinator(), new Set(['A']), NOW)).toEqual(COORD);
  });

  it('adds a live additional role held in the organisation', () => {
    const held = [{ roleKey: 'data_export', orgId: 'A', expiresAt: null }];
    expect(effectivePermissions(index, coordinator(held), new Set(['A']), NOW)).toEqual(
      [...COORD, 'profiles.export'].sort(),
    );
  });

  it('ignores an expired additional role', () => {
    const held = [{ roleKey: 'pii_access', orgId: 'A', expiresAt: NOW }];
    expect(effectivePermissions(index, coordinator(held), new Set(['A']), NOW)).toEqual(COORD);
  });

  it('counts a role with an expiry still in the future', () => {
    const held = [{ roleKey: 'pii_access', orgId: 'A', expiresAt: NOW + 1 }];
    expect(effectivePermissions(index, coordinator(held), new Set(['A']), NOW)).toContain(
      'profiles.view_pii',
    );
  });

  it('gives nothing in an organisation the user is not part of', () => {
    expect(effectivePermissions(index, coordinator(), new Set(['B']), NOW)).toEqual([]);
  });

  it('ignores a held role in an organisation the user is not part of', () => {
    const held = [{ roleKey: 'data_export', orgId: 'B', expiresAt: null }];
    expect(effectivePermissions(index, coordinator(held), null, NOW)).toEqual(COORD);
  });

  it('ignores a role for another account type', () => {
    const held = [{ roleKey: 'org_onboarder', orgId: 'A', expiresAt: null }];
    expect(effectivePermissions(index, coordinator(held), new Set(['A']), NOW)).toEqual(COORD);
  });

  it('ignores an unknown role key', () => {
    const held = [{ roleKey: 'gone', orgId: 'A', expiresAt: null }];
    expect(effectivePermissions(index, coordinator(held), new Set(['A']), NOW)).toEqual(COORD);
  });

  it('separates two owned organisations by their additional roles', () => {
    const owner: PermissionSubject = {
      userType: 'admin',
      memberships: [ownerOf('A'), ownerOf('B')],
      held: [{ roleKey: 'org_onboarder', orgId: 'A', expiresAt: null }],
    };
    expect(effectivePermissions(index, owner, new Set(['A']), NOW)).toContain('orgs.onboard');
    expect(effectivePermissions(index, owner, new Set(['B']), NOW)).not.toContain('orgs.onboard');
    expect(effectivePermissions(index, owner, null, NOW)).toContain('orgs.onboard');
  });

  it("applies the root owner's role in an organisation below it", () => {
    const admin: PermissionSubject = { userType: 'admin', memberships: [ROOT], held: [] };
    const inA = effectivePermissions(index, admin, new Set(['A', 'NF']), NOW);
    expect(inA).toContain('network.administer');
    expect(inA).not.toContain('profiles.view_pii');
  });

  it('never lets the root contribute personal data', () => {
    const pii = buildRole({
      key: 'root_pii',
      accountType: 'admin',
      assignableOrgTypes: ['network_facilitator', 'aggregator'],
      permissions: ['profiles.view_pii', 'profiles.view'],
    });
    const idx = indexRoles([...index.byKey.values(), pii]);
    const admin: PermissionSubject = {
      userType: 'admin',
      memberships: [ROOT],
      held: [{ roleKey: 'root_pii', orgId: 'NF', expiresAt: null }],
    };
    const got = effectivePermissions(idx, admin, null, NOW);
    expect(got).toContain('profiles.view');
    expect(got).not.toContain('profiles.view_pii');
  });

  it('ignores a role not assignable in the organisation type', () => {
    const held = (orgId: string) => [{ roleKey: 'admin_actor', orgId, expiresAt: null }];
    const atRoot: PermissionSubject = { userType: 'admin', memberships: [ROOT], held: held('NF') };
    expect(effectivePermissions(index, atRoot, null, NOW)).not.toContain('profiles.act_on_behalf');
    const inB: PermissionSubject = {
      userType: 'admin',
      memberships: [ownerOf('B')],
      held: held('B'),
    };
    expect(effectivePermissions(index, inB, new Set(['B']), NOW)).toContain(
      'profiles.act_on_behalf',
    );
  });
});
