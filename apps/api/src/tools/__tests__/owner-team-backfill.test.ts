import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOrganisation, type Organisation } from '../../services/organisation-store/index.js';
import {
  BACKFILL_CONSENT_SOURCE,
  documentsMatcher,
  ownerTeamBackfillStep,
  type ExistingTeamAccount,
  type OrgConsentRow,
  type OwnerTeamBackfillDeps,
} from '../owner-team-backfill.js';

const NOW = new Date('2026-11-23T00:00:00.000Z');
const CONSENT: OrgConsentRow = {
  termsVersion: 2,
  privacyVersion: 2,
  acceptedAt: new Date('2026-11-01T00:00:00.000Z'),
  validTill: new Date('2027-11-01T00:00:00.000Z'),
};

let seq = 0;
/** An active org with an owner who has a login and a phone. */
function org(overrides: Partial<Organisation> = {}): Organisation {
  seq += 1;
  const n = String(seq).padStart(2, '0');
  return buildOrganisation({
    id: `00000000-0000-4000-8000-0000000000${n}`,
    slug: `org-${n}`,
    displayName: `Org ${n}`,
    status: 'active',
    ownerUserId: `owner-${n}`,
    ownerEmail: `owner-${n}@org.test`,
    ownerPhone: '+919000000001',
    ownerKcSub: `sub-${n}`,
    createdAt: new Date(`2026-10-${n}T00:00:00.000Z`),
    ...overrides,
  });
}

function deps(
  orgs: Organisation[],
  overrides: Partial<OwnerTeamBackfillDeps> = {},
): OwnerTeamBackfillDeps & {
  create: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
} {
  return {
    listActiveOrgs: async () => orgs,
    orgConsent: async () => CONSENT,
    documentsMatch: async () => true,
    teamAccountOf: async () => null,
    domainIds: ['seeker', 'provider'],
    create: vi.fn(async () => ({ success: true as const, value: 'new-account' })),
    approve: vi.fn(async () => ({ success: true as const, value: 'new-account' })),
    now: () => NOW,
    ...overrides,
  } as OwnerTeamBackfillDeps & {
    create: ReturnType<typeof vi.fn>;
    approve: ReturnType<typeof vi.fn>;
  };
}

describe('ownerTeamBackfillStep', () => {
  it('creates and approves a team account with consent derived from the org consent', async () => {
    const o = org({ profile: { domains: ['seeker'] } });
    const d = deps([o]);

    const report = await ownerTeamBackfillStep(d, { dryRun: false });

    expect(report.created).toEqual([o.id]);
    expect(d.create).toHaveBeenCalledWith({
      org: o,
      subject: o.ownerKcSub,
      serves: ['seeker'],
      consent: {
        value: true,
        given_at: CONSENT.acceptedAt.toISOString(),
        valid_till: CONSENT.validTill?.toISOString(),
      },
      derivedConsent: { termsVersion: 2, privacyVersion: 2, source: BACKFILL_CONSENT_SOURCE },
    });
    expect(d.approve).toHaveBeenCalledWith(o);
  });

  it('serves every network domain when the org chose none', async () => {
    const d = deps([org()]);
    await ownerTeamBackfillStep(d, { dryRun: false });
    expect(d.create.mock.calls[0]?.[0]).toMatchObject({ serves: ['seeker', 'provider'] });
  });

  it('writes nothing in a dry run, reporting what it would do', async () => {
    const pending = org();
    const fresh = org();
    const d = deps([pending, fresh], {
      teamAccountOf: async (o) =>
        o.id === pending.id ? { id: 'p', orgId: pending.id, status: 'pending' } : null,
    });

    const report = await ownerTeamBackfillStep(d, { dryRun: true });

    expect(report.created).toEqual([fresh.id]);
    expect(report.approved).toEqual([pending.id]);
    expect(d.create).not.toHaveBeenCalled();
    expect(d.approve).not.toHaveBeenCalled();
  });

  it('skips the Default org and an owner who already has a team account', async () => {
    const def = org({ isDefault: true });
    const has = org();
    const d = deps([def, has], {
      teamAccountOf: async (): Promise<ExistingTeamAccount> => ({
        id: 'x',
        orgId: has.id,
        status: 'active',
      }),
    });

    const report = await ownerTeamBackfillStep(d, { dryRun: false });

    expect(report.orgs).toBe(1);
    expect(report.skipped.has_team_account).toEqual([has.id]);
    expect(d.create).not.toHaveBeenCalled();
  });

  it('approves a pending account the owner already has in this org', async () => {
    const o = org();
    const d = deps([o], {
      teamAccountOf: async () => ({ id: 'p', orgId: o.id, status: 'pending' }),
    });
    const report = await ownerTeamBackfillStep(d, { dryRun: false });
    expect(report.approved).toEqual([o.id]);
    expect(d.create).not.toHaveBeenCalled();
  });

  it('gives an owner of several orgs one account, in the earliest org', async () => {
    const later = org({ ownerUserId: 'same', createdAt: new Date('2026-10-20T00:00:00.000Z') });
    const earlier = org({ ownerUserId: 'same', createdAt: new Date('2026-10-02T00:00:00.000Z') });
    const d = deps([later, earlier]);

    const report = await ownerTeamBackfillStep(d, { dryRun: false });

    expect(report.created).toEqual([earlier.id]);
    expect(report.skipped.team_account_in_other_org).toEqual([later.id]);
  });

  it('skips owners with no login, no phone, no or expired org consent', async () => {
    const noLogin = org({ ownerKcSub: null });
    const noPhone = org({ ownerPhone: null });
    const noConsent = org();
    const expired = org();
    const d = deps([noLogin, noPhone, noConsent, expired], {
      orgConsent: async (id) => {
        if (id === noConsent.id) return null;
        if (id === expired.id) return { ...CONSENT, validTill: new Date('2026-01-01T00:00:00Z') };
        return CONSENT;
      },
    });

    const report = await ownerTeamBackfillStep(d, { dryRun: false });

    expect(report.skipped.no_login).toEqual([noLogin.id]);
    expect(report.skipped.no_phone).toEqual([noPhone.id]);
    expect(report.skipped.no_org_consent).toEqual([noConsent.id]);
    expect(report.skipped.org_consent_expired).toEqual([expired.id]);
    expect(d.create).not.toHaveBeenCalled();
  });

  it('skips an owner whose org documents differ from the team member documents', async () => {
    const o = org();
    const documentsMatch = vi.fn(async () => false);
    const d = deps([o], { documentsMatch });

    const report = await ownerTeamBackfillStep(d, { dryRun: false });

    expect(documentsMatch).toHaveBeenCalledWith(2, 2);
    expect(report.skipped.documents_differ).toEqual([o.id]);
    expect(d.create).not.toHaveBeenCalled();
  });

  it('reports a failed create or approval with its code', async () => {
    const badCreate = org();
    const badApprove = org();
    const d = deps([badCreate, badApprove], {
      create: vi.fn(async (input: { org: Organisation }) =>
        input.org.id === badCreate.id
          ? { success: false as const, error: { code: 'UNAVAILABLE' as const, message: 'x' } }
          : { success: true as const, value: 'id' },
      ),
      approve: vi.fn(async () => ({
        success: false as const,
        error: { code: 'NO_PROFILE_TYPES' as const, message: 'x' },
      })),
    });

    const report = await ownerTeamBackfillStep(d, { dryRun: false });

    expect(report.failed).toEqual([
      { orgId: badCreate.id, code: 'UNAVAILABLE' },
      { orgId: badApprove.id, code: 'NO_PROFILE_TYPES' },
    ]);
  });
});

describe('documentsMatcher', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('matches where the org and team member documents are the same (UP)', async () => {
    vi.stubEnv('AGGREGATOR_NETWORK', 'blue_dot');
    vi.stubEnv('AGGREGATOR_BRAND', 'up-gzb');
    const match = await documentsMatcher();
    expect(await match(2, 2)).toBe(true);
    expect(await match(99, 2)).toBe(false);
  });

  it('does not match where they differ (default content)', async () => {
    vi.stubEnv('AGGREGATOR_NETWORK', 'blue_dot');
    vi.stubEnv('AGGREGATOR_BRAND', '');
    const match = await documentsMatcher();
    expect(await match(1, 1)).toBe(false);
  });
});
