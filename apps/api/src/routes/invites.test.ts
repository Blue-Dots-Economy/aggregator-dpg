// Invite mint + grant-recovery routes (#700/#701). Flag must be set before any
// import that pulls in `config`.
process.env.ORG_HIERARCHY_ENABLED = 'true';

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
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { mintGrantToken, _resetGrantTokenKey } from '../services/grant-token.js';
import { _setInviteMintRateChecker } from '../services/invite-mint-rate.js';

const ORG_ID = '00000000-0000-0000-0000-0000000000d1';

describe('invite mint routes', () => {
  let app: FastifyInstance;
  let orgStore: AggregatorOrgStoreFake;
  let invites: RegistrationInvitesStoreFake;
  let mailer: FakeMailer;

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

    _setAggregatorOrgStore(orgStore);
    _setRegistrationInvitesStore(invites);
    _setMailer(mailer);
    _setInviteMintRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setAggregatorOrgStore(null);
    _setRegistrationInvitesStore(null);
    _setMailer(null);
    _setInviteMintRateChecker(null);
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

  it('recovers an expired grant: re-mails a fresh link to the registered owner, mints nothing', async () => {
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
    expect(mailer.outbox[0]?.html).toContain('/register/invite?grant=');
  });

  it('rejects an invalid grant (400)', async () => {
    const res = await mint({ grant: 'garbage', recipients: [{ email: 'a@x.org' }] });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('GRANT_INVALID');
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

  it('returns 429 when the per-org rate limit trips', async () => {
    _setInviteMintRateChecker(async () => ({ allowed: false, retryAfterSeconds: 30 }));
    const grant = await grantFor();
    const res = await mint({ grant, recipients: [{ email: 'a@x.org' }] });
    expect(res.statusCode).toBe(429);
  });
});
