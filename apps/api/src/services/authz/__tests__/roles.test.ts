import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { indexRoles } from '@aggregator-dpg/rbac';
import { INVITE_DEFAULT_ROLE_KEYS } from '@aggregator-dpg/shared-primitives/user-org';
import { InMemoryRoleStore, _setRoleStore } from '../../role-store/index.js';
import { _setRbacRuntime } from '../runtime.js';
import { shippedRoles, testRbacRuntime } from '../testing.js';
import { grantInviteDefaultRoles } from '../roles.js';

const USER = 'user-1';
const ORG = { id: 'org-1', orgType: 'aggregator' as const };
const OWNER = 'owner-1';
const NOW = new Date('2026-11-17T00:00:00Z');

describe('grantInviteDefaultRoles', () => {
  let store: InMemoryRoleStore;

  beforeEach(async () => {
    store = new InMemoryRoleStore();
    _setRoleStore(store);
    _setRbacRuntime(await testRbacRuntime('enforce'));
  });

  afterEach(() => {
    _setRbacRuntime(null);
    _setRoleStore(null);
  });

  it('grants Data Export and PII Access with no expiry, audited as the owner', async () => {
    const outcome = await grantInviteDefaultRoles(USER, ORG, OWNER, { now: NOW });

    expect(outcome).toEqual({ granted: ['data_export', 'pii_access'], present: [], skipped: [] });
    expect(store.assignments.map((a) => [a.roleKey, a.orgId, a.grantedBy, a.expiresAt])).toEqual([
      ['data_export', ORG.id, OWNER, null],
      ['pii_access', ORG.id, OWNER, null],
    ]);
    expect(store.audit).toHaveLength(INVITE_DEFAULT_ROLE_KEYS.length);
    expect(store.audit[0]).toMatchObject({
      event: 'role.assign',
      actorUserId: OWNER,
      targetUserId: USER,
      targetOrgId: ORG.id,
      details: { role: 'data_export', expires_at: null, reason: 'invite_default' },
    });
  });

  it('records a backfill grant with its own reason', async () => {
    await grantInviteDefaultRoles(USER, ORG, OWNER, {
      reason: 'default_backfill',
      syncToken: false,
      now: NOW,
    });

    expect(store.audit.map((e) => e.details?.['reason'])).toEqual([
      'default_backfill',
      'default_backfill',
    ]);
  });

  it('leaves a role already live in the organisation alone', async () => {
    store.seed([{ userId: USER, roleKey: 'pii_access', orgId: ORG.id }]);

    const outcome = await grantInviteDefaultRoles(USER, ORG, OWNER, { now: NOW });

    expect(outcome).toEqual({ granted: ['data_export'], present: ['pii_access'], skipped: [] });
    expect(store.assignments.filter((a) => a.roleKey === 'pii_access')).toHaveLength(1);
  });

  it('grants a role again when the live one is in another organisation', async () => {
    store.seed([{ userId: USER, roleKey: 'pii_access', orgId: 'other-org' }]);

    const outcome = await grantInviteDefaultRoles(USER, ORG, OWNER, { now: NOW });

    expect(outcome.granted).toEqual(['data_export', 'pii_access']);
  });

  it('refuses the roles in an organisation type that cannot hold them', async () => {
    const outcome = await grantInviteDefaultRoles(
      USER,
      { id: 'root', orgType: 'network_facilitator' },
      OWNER,
      { now: NOW },
    );

    expect(outcome).toEqual({ granted: [], present: [], skipped: ['data_export', 'pii_access'] });
    expect(store.assignments).toEqual([]);
  });

  it("gives a role with a day limit that role's longest validity", async () => {
    const roles = (await shippedRoles()).map((r) =>
      r.key === 'pii_access' ? { ...r, maxDays: 30 } : r,
    );
    _setRbacRuntime({ ...(await testRbacRuntime('enforce')), roles: indexRoles(roles) });

    await grantInviteDefaultRoles(USER, ORG, OWNER, { now: NOW });

    const pii = store.assignments.find((a) => a.roleKey === 'pii_access');
    expect(pii?.expiresAt).toEqual(new Date('2026-12-17T00:00:00Z'));
  });

  it('does nothing with RBAC off', async () => {
    _setRbacRuntime(null);

    const outcome = await grantInviteDefaultRoles(USER, ORG, OWNER, { now: NOW });

    expect(outcome).toEqual({ granted: [], present: [], skipped: [] });
    expect(store.assignments).toEqual([]);
  });

  it('skips a role missing from the catalogue and grants the rest', async () => {
    const roles = (await shippedRoles()).filter((r) => r.key !== 'data_export');
    _setRbacRuntime({ ...(await testRbacRuntime('enforce')), roles: indexRoles(roles) });

    const outcome = await grantInviteDefaultRoles(USER, ORG, OWNER, { now: NOW });

    expect(outcome).toEqual({ granted: ['pii_access'], present: [], skipped: ['data_export'] });
  });

  it('reports a store failure as skipped without throwing', async () => {
    store.failWith({ code: 'DB_UNAVAILABLE', message: 'down' });

    const outcome = await grantInviteDefaultRoles(USER, ORG, OWNER, { now: NOW });

    expect(outcome).toEqual({ granted: [], present: [], skipped: ['data_export', 'pii_access'] });
  });
});
