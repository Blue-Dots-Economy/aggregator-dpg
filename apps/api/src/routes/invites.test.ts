// Invite mint + grant-recovery routes (#700/#701).

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  AggregatorOrgStoreFake,
  buildAggregatorOrg,
  _setAggregatorOrgStore,
} from '../services/aggregator-org-store/index.js';
import {
  RegistrationInvitesStoreFake,
  _setRegistrationInvitesStore,
} from '../services/registration-invites-store/index.js';
import {
  AggregatorStoreFake,
  buildAggregator,
  _setAggregatorStore,
} from '../services/aggregator-store/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { mintGrantToken, _resetGrantTokenKey } from '../services/grant-token.js';
import {
  _setInviteMintRateChecker,
  _setInviteIpRateChecker,
} from '../services/invite-mint-rate.js';

const ORG_ID = '00000000-0000-0000-0000-0000000000d1';

describe('invite mint routes', () => {
  let app: FastifyInstance;
  let orgStore: AggregatorOrgStoreFake;
  let invites: RegistrationInvitesStoreFake;
  let mailer: FakeMailer;
  let coordinators: AggregatorStoreFake;

  beforeEach(async () => {
    _resetGrantTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    orgStore = new AggregatorOrgStoreFake();
    invites = new RegistrationInvitesStoreFake();
    mailer = new FakeMailer();

    orgStore.seed([
      buildAggregatorOrg({
        id: ORG_ID,
        slug: 'o',
        displayName: 'Joint Facilitation Centre',
        status: 'active',
        ownerEmail: 'owner@jfc.org',
      }),
    ]);

    coordinators = new AggregatorStoreFake();
    _setAggregatorStore(coordinators);
    _setAggregatorOrgStore(orgStore);
    _setRegistrationInvitesStore(invites);
    _setMailer(mailer);
    _setInviteMintRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    _setInviteIpRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setAggregatorStore(null);
    _setAggregatorOrgStore(null);
    _setRegistrationInvitesStore(null);
    _setMailer(null);
    _setInviteMintRateChecker(null);
    _setInviteIpRateChecker(null);
  });

  async function grantFor(org = ORG_ID, ttlSec?: number): Promise<string> {
    const { token } = await mintGrantToken(ttlSec === undefined ? { org } : { org, ttlSec });
    return token;
  }

  function mint(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/admin/v1/invites', payload });
  }

  it('mints invites for valid recipients, emails each, returns a summary', async () => {
    const grant = await grantFor();
    const res = await mint({
      grant,
      recipients: [{ email: 'a@x.org' }, { email: 'b@x.org', name: 'Bee' }],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sent: number; resent: number; invalid: unknown[] };
    expect(body.sent).toBe(2);
    expect(body.resent).toBe(0);
    expect(body.invalid).toEqual([]);
    expect(mailer.outbox.length).toBe(2);
    // Invite rows exist and are pending.
    const a = await invites.findPendingByOrgAndEmail(ORG_ID, 'a@x.org');
    expect(a.ok && a.value?.status).toBe('pending');
  });

  it('reports an already-pending address as resent (refresh, not duplicate)', async () => {
    const grant = await grantFor();
    await mint({ grant, recipients: [{ email: 'a@x.org' }] });
    const res = await mint({ grant, recipients: [{ email: 'a@x.org' }] });
    const body = res.json() as { sent: number; resent: number };
    expect(body.sent).toBe(0);
    expect(body.resent).toBe(1);
  });

  it('buckets an invalid email address', async () => {
    const grant = await grantFor();
    const res = await mint({ grant, recipients: [{ email: 'not-an-email' }] });
    const body = res.json() as { sent: number; invalid: Array<{ reason: string }> };
    expect(body.sent).toBe(0);
    expect(body.invalid[0]?.reason).toBe('invalid_email');
  });

  it('de-dupes a repeated address within one batch', async () => {
    const grant = await grantFor();
    const res = await mint({
      grant,
      recipients: [{ email: 'a@x.org' }, { email: 'A@X.org' }],
    });
    const body = res.json() as { sent: number; invalid: Array<{ reason: string }> };
    expect(body.sent).toBe(1);
    expect(body.invalid[0]?.reason).toBe('duplicate_in_batch');
  });

  it('reports an own-org coordinator as existing and mails nothing (C9)', async () => {
    coordinators.seed([
      buildAggregator({
        id: '00000000-0000-4000-8000-00000000c001',
        orgSlug: 'own-c',
        parentOrgId: ORG_ID,
        status: 'pending',
        contact: { name: 'Own', phone: '+919000000101', email: 'own@x.org' },
        contactPhone: '+919000000101',
        contactEmail: 'own@x.org',
      }),
    ]);
    const res = await mint({ grant: await grantFor(), recipients: [{ email: 'own@x.org' }] });
    const body = res.json() as { sent: number; existing: Array<{ status: string }> };
    expect(body.sent).toBe(0);
    expect(body.existing).toEqual([{ email: 'own@x.org', status: 'pending' }]);
    expect(mailer.outbox.length).toBe(0);
  });

  it('answers another account as sent and mails "already have an account", no invite (C9)', async () => {
    coordinators.seed([
      buildAggregator({
        id: '00000000-0000-4000-8000-00000000c002',
        orgSlug: 'other-c',
        parentOrgId: '00000000-0000-0000-0000-0000000000d2',
        status: 'active',
        contact: { name: 'Other', phone: '+919000000102', email: 'other@x.org' },
        contactPhone: '+919000000102',
        contactEmail: 'other@x.org',
      }),
    ]);
    const grant = await grantFor();
    const res = await mint({ grant, recipients: [{ email: 'other@x.org' }] });
    const body = res.json() as { sent: number; existing: unknown[] };
    expect(body.sent).toBe(1);
    expect(body.existing).toEqual([]);
    expect(mailer.outbox[0]?.html).toContain('already have an account');
    expect(mailer.outbox[0]?.html).not.toContain('invite=');
    // A repeat reads exactly like a repeat to a fresh address: `resent`.
    const again = (await mint({ grant, recipients: [{ email: 'other@x.org' }] })).json() as {
      sent: number;
      resent: number;
    };
    expect(again).toMatchObject({ sent: 0, resent: 1 });
  });

  it('recovers an expired grant: mails a sign-in link to the registered owner, mints nothing', async () => {
    const grant = await grantFor(ORG_ID, -1);
    const res = await mint({ grant, recipients: [{ email: 'a@x.org' }] });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { recovered: boolean; sent: number };
    expect(body.recovered).toBe(true);
    expect(body.sent).toBe(0);
    // No invite minted; a fresh grant link mailed to the REGISTERED owner.
    const a = await invites.findPendingByOrgAndEmail(ORG_ID, 'a@x.org');
    expect(a.ok && a.value).toBeNull();
    expect(mailer.outbox.length).toBe(1);
    expect(mailer.outbox[0]?.to).toBe('owner@jfc.org');
    // Phase 5: a console sign-in link, never a fresh grant.
    expect(mailer.outbox[0]?.html).toContain('/login');
    expect(mailer.outbox[0]?.html).not.toContain('grant=');
  });

  it('rejects an invalid grant (400)', async () => {
    const res = await mint({ grant: 'garbage', recipients: [{ email: 'a@x.org' }] });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('GRANT_INVALID');
  });

  it('rejects minting for the Default org, which has no owner console (409, 0028)', async () => {
    orgStore.seed([
      buildAggregatorOrg({
        id: ORG_ID,
        slug: 'default',
        status: 'active',
        isDefault: true,
        ownerEmail: 'owner@jfc.org',
      }),
    ]);
    const grant = await grantFor();
    const res = await mint({ grant, recipients: [{ email: 'a@x.org' }] });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('TARGET_ORG_INACTIVE');
    expect(mailer.outbox).toHaveLength(0);
  });

  it('rejects minting for a non-active org (409)', async () => {
    orgStore.seed([
      buildAggregatorOrg({
        id: ORG_ID,
        slug: 'o',
        status: 'inactive',
        ownerEmail: 'owner@jfc.org',
      }),
    ]);
    const grant = await grantFor();
    const res = await mint({ grant, recipients: [{ email: 'a@x.org' }] });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('TARGET_ORG_INACTIVE');
  });

  it('buckets store_error when the invites store fails to resolve a row', async () => {
    // Force the store to fail so resolveInviteJti returns null → store_error.
    class FailingInvites extends RegistrationInvitesStoreFake {
      override async findPendingByOrgAndEmail() {
        return { ok: false as const, error: { code: 'DB_UNAVAILABLE' as const, message: 'x' } };
      }
    }
    _setRegistrationInvitesStore(new FailingInvites());
    const grant = await grantFor();
    const res = await mint({ grant, recipients: [{ email: 'a@x.org' }] });
    const body = res.json() as { sent: number; invalid: Array<{ reason: string }> };
    expect(body.sent).toBe(0);
    expect(body.invalid[0]?.reason).toBe('store_error');
  });

  it('returns 429 when the per-org rate limit trips', async () => {
    _setInviteMintRateChecker(async () => ({ allowed: false, retryAfterSeconds: 30 }));
    const grant = await grantFor();
    const res = await mint({ grant, recipients: [{ email: 'a@x.org' }] });
    expect(res.statusCode).toBe(429);
  });

  it('rate-limits the expired-grant recovery path too (H1)', async () => {
    // Per-org limit is checked BEFORE the recovery branch, so a looped expired
    // grant can't send unbounded mail. Denied → 429, no email sent.
    _setInviteMintRateChecker(async () => ({ allowed: false, retryAfterSeconds: 30 }));
    const grant = await grantFor(ORG_ID, -1);
    const res = await mint({ grant, recipients: [{ email: 'a@x.org' }] });
    expect(res.statusCode).toBe(429);
    expect(mailer.outbox.length).toBe(0);
  });

  it('returns 429 when the per-IP throttle trips, before touching the grant (M4)', async () => {
    _setInviteIpRateChecker(async () => ({ allowed: false, retryAfterSeconds: 15 }));
    const res = await mint({ grant: 'anything', recipients: [{ email: 'a@x.org' }] });
    expect(res.statusCode).toBe(429);
  });
});
