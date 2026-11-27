import { describe, expect, it } from 'vitest';
import { PRE_TRAIN_WHEN, type JournalEntry } from '../../db/migrate-core.js';
import { tokenRealmRoles, upgradeLevel } from '../instance-upgrade-logic.js';

const LATEST = 1791500000000;
const journal: JournalEntry[] = [
  { when: 1700000000000, tag: '0000_init' },
  { when: PRE_TRAIN_WHEN, tag: '0022_campaign_pii_audit' },
  { when: 1790600000000, tag: '0023_drop_aggregator_profile' },
  { when: LATEST, tag: '0030_user_org_api' },
];
const row = (when: number) => ({ createdAt: when, hash: 'h' });

describe('upgradeLevel', () => {
  it('reads exactly 0022 as the start, with the whole train pending', () => {
    expect(upgradeLevel(journal, [row(1700000000000), row(PRE_TRAIN_WHEN)])).toEqual({
      state: 'start',
      appliedTag: '0022_campaign_pii_audit',
      pending: ['0023_drop_aggregator_profile', '0030_user_org_api'],
    });
  });

  it('reads the latest shipped migration as done', () => {
    expect(upgradeLevel(journal, [row(PRE_TRAIN_WHEN), row(LATEST)])).toEqual({
      state: 'done',
      appliedTag: '0030_user_org_api',
      pending: [],
    });
  });

  it('reads nothing applied as fresh', () => {
    expect(upgradeLevel(journal, null).state).toBe('fresh');
    expect(upgradeLevel(journal, []).pending).toHaveLength(4);
  });

  it('reads a shipped level part-way through the train as partial', () => {
    expect(upgradeLevel(journal, [row(PRE_TRAIN_WHEN), row(1790600000000)])).toEqual({
      state: 'partial',
      appliedTag: '0023_drop_aggregator_profile',
      pending: ['0030_user_org_api'],
    });
  });

  it('reads a level below 0022 or one this release does not ship as other', () => {
    expect(upgradeLevel(journal, [row(1700000000000)]).state).toBe('other');
    expect(upgradeLevel(journal, [row(PRE_TRAIN_WHEN + 1)])).toMatchObject({
      state: 'other',
      appliedTag: null,
    });
  });

  it('decides by the high-water mark, not the order of the rows', () => {
    expect(upgradeLevel(journal, [row(PRE_TRAIN_WHEN), row(1700000000000)]).state).toBe('start');
  });
});

describe('tokenRealmRoles', () => {
  /** A token response whose access token carries `payload` as its claims. */
  function tokenBody(payload: unknown): { access_token: string } {
    const claims = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { access_token: `header.${claims}.signature` };
  }

  it('reads the token and its realm-management roles', () => {
    const body = tokenBody({
      resource_access: { 'realm-management': { roles: ['manage-realm', 'manage-users'] } },
    });
    expect(tokenRealmRoles(body)).toEqual({
      token: body.access_token,
      roles: ['manage-realm', 'manage-users'],
    });
  });

  it('answers no roles when the token has no realm-management access', () => {
    const body = tokenBody({ resource_access: { account: { roles: ['view-profile'] } } });
    expect(tokenRealmRoles(body).roles).toEqual([]);
  });

  it('answers an empty token and no roles for a body without an access token', () => {
    expect(tokenRealmRoles({ error: 'unauthorized_client' })).toEqual({ token: '', roles: [] });
    expect(tokenRealmRoles(null)).toEqual({ token: '', roles: [] });
  });

  it('answers no roles when the claims are not JSON or have the wrong shape', () => {
    expect(tokenRealmRoles({ access_token: 'header.not-json.signature' }).roles).toEqual([]);
    expect(
      tokenRealmRoles(tokenBody({ resource_access: { 'realm-management': { roles: 'all' } } }))
        .roles,
    ).toEqual([]);
  });
});
