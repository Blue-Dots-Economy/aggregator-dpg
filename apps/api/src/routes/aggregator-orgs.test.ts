// The org-hierarchy routes are flag-gated; `config` reads env once at import,
// so the flag must be set before any import that pulls in `config`.
process.env.ORG_HIERARCHY_ENABLED = 'true';

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  AggregatorOrgStoreFake,
  buildAggregatorOrg,
  _setAggregatorOrgStore,
  AggregatorOrgStoreBase,
  type AggregatorOrg,
  type CreateOrgInput,
  type OrgStoreResult,
} from '../services/aggregator-org-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _resetTokenKey } from '../services/approval-token.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { _setConsentLedger } from '../services/consent-ledger/index.js';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { _setSubmitRateChecker } from '../services/submit-rate.js';
import { _setOrgInviteResendRateChecker } from '../services/org-invite-resend-rate.js';
import type * as ConfigLoaderFs from '@aggregator-dpg/config-loader/fs';

const { loadConsentConfigMock } = vi.hoisted(() => ({ loadConsentConfigMock: vi.fn() }));
vi.mock('@aggregator-dpg/config-loader/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigLoaderFs>();
  return { ...actual, loadConsentConfig: loadConsentConfigMock };
});

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('aggregator-orgs routes', () => {
  let app: FastifyInstance;
  let orgStore: AggregatorOrgStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;
  let consentLedger: ConsentLedgerFake;

  beforeEach(async () => {
    _resetTokenKey();
    _resetJwks();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.ADMIN_EMAILS = 'reviewer@bluedots.local';
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    orgStore = new AggregatorOrgStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();
    consentLedger = new ConsentLedgerFake();

    // Permissive by default, NOT `null`. `null` restores the Redis-backed
    // limiter, whose bucket is keyed `ip|email` — constant across this file —
    // so submits past the window cap 429 and which tests fail depends on the
    // wall clock. Cases that assert throttling install their own denier.
    _setSubmitRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    // Allow by default; the throttle cases override per-test.
    _setOrgInviteResendRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    loadConsentConfigMock.mockReset();
    const actualLoader = await vi.importActual<typeof ConfigLoaderFs>(
      '@aggregator-dpg/config-loader/fs',
    );
    loadConsentConfigMock.mockImplementation(actualLoader.loadConsentConfig);

    _setAggregatorOrgStore(orgStore);
    _setIdpAdmin(idp);
    _setMailer(mailer);
    _setConsentLedger(consentLedger);
    _setAccessTokenVerifier(async (token) => {
      if (token === SERVICE_BEARER) {
        return { sub: 'service-account-aggregator-bff', azp: 'aggregator-bff' };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setAggregatorOrgStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setConsentLedger(null);
    _setAccessTokenVerifier(null);
    _setSubmitRateChecker(null);
    _setOrgInviteResendRateChecker(null);
  });

  const orgBody = {
    display_name: 'Enable India',
    state: 'Karnataka',
    owner: { name: 'Ravi Kumar', email: 'ravi@enable.org', phone: '+919876500000' },
    consent: { value: true, given_at: '2026-01-15T10:00:00Z', valid_till: '2027-01-15T10:00:00Z' },
  };

  it('creates a pending org + mirrored group + disabled owner, emails the network admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { org_id: string; status: string };
    expect(body.status).toBe('pending');
    const stored = await orgStore.findById(body.org_id);
    expect(stored.ok && stored.value?.status).toBe('pending');
    expect(stored.ok && stored.value?.kcGroupId).toBeTruthy();
    // Mirrored group carries the human org name as an attribute (name is slug-based).
    const groupId = stored.ok ? stored.value?.kcGroupId : undefined;
    const group = groupId ? idp.getGroup(groupId) : undefined;
    expect(group?.attributes?.['display_name']).toBe('Enable India');
    expect(stored.ok && stored.value?.ownerKcSub).toBeTruthy();
    // Owner KC user created disabled.
    const owner = await idp.findByEmail('ravi@enable.org');
    expect(owner.ok && owner.value?.enabled).toBe(false);
    // A review email went to the network admin.
    expect(mailer.outbox.length).toBe(1);
    expect(mailer.outbox[0]?.to).toContain('reviewer@bluedots.local');

    // Consent ledger should have one row for the org
    const ledgerRows = consentLedger.list();
    expect(ledgerRows).toHaveLength(1);
    const consentRow = ledgerRows[0];
    expect(consentRow?.subjectType).toBe('org');
    expect(consentRow?.subjectId).toBe(body.org_id);
    expect(consentRow?.termsVersion).toBeGreaterThanOrEqual(1);
    expect(consentRow?.privacyVersion).toBeGreaterThanOrEqual(1);
    expect(consentRow?.source).toBe('registration');
    // network/brand must come from AGGREGATOR_NETWORK/AGGREGATOR_BRAND so the
    // recorded version matches what the web layer displayed.
    expect(consentRow?.network).toBe('blue_dot'); // default when AGGREGATOR_NETWORK unset
    expect(consentRow?.brand).toBeNull(); // default when AGGREGATOR_BRAND unset
  });

  it('records org consent in the ledger on successful registration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(201);
    const { org_id } = res.json() as { org_id: string };

    const ledgerRows = consentLedger.list();
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.subjectType).toBe('org');
    expect(ledgerRows[0]?.subjectId).toBe(org_id);
  });

  it('fails org registration (fail-closed) when the consent ledger write fails', async () => {
    // Make the ledger always return an error
    consentLedger.recordRegistrationConsent = async () => ({
      success: false as const,
      error: Object.assign(new Error('ledger down'), {
        name: 'UpstreamError',
        code: 'CONSENT_INSERT_FAILED',
      }) as BaseError,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'ledger-fail@enable.org' } },
    });
    // Fail-closed: the org path has no fallback, so a consent-write failure
    // rolls the registration back rather than returning 201.
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('CONSENT_WRITE_FAILED');
  });

  it('GET /v1/orgs lists only active orgs', async () => {
    orgStore.seed([
      buildAggregatorOrg({ id: 'o-active', slug: 'a', displayName: 'A', status: 'active' }),
      buildAggregatorOrg({ id: 'o-pending', slug: 'b', displayName: 'B', status: 'pending' }),
    ]);
    const res = await app.inject({ method: 'GET', url: '/v1/orgs', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { orgs: { id: string; slug: string; display_name: string }[] };
    expect(body.orgs.map((o) => o.slug)).toEqual(['a']);
    expect(body.orgs[0]?.display_name).toBe('A');
  });

  it('rejects org registration when consent.value is false (400/validation)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, consent: { ...orgBody.consent, value: false } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('re-mints the review link for a pending org on resubmit — no field overwrite (§7)', async () => {
    orgStore.seed([
      buildAggregatorOrg({
        id: 'o-reclaim',
        slug: 'enable-india-abcd',
        displayName: 'Old Name',
        ownerEmail: 'ravi@enable.org',
        status: 'pending',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody, // display_name 'Enable India' — must be IGNORED
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { org_id: string; status: string };
    expect(body.org_id).toBe('o-reclaim');
    expect(body.status).toBe('pending');
    // On-file record is NOT overwritten (no takeover); link re-sent.
    const stored = await orgStore.findById('o-reclaim');
    expect(stored.ok && stored.value?.displayName).toBe('Old Name');
    expect(mailer.outbox.length).toBe(1);
  });

  it('returns 409 REGISTRATION_COOLING for a rejected org inside the cooling window', async () => {
    orgStore.seed([
      buildAggregatorOrg({
        id: 'o-cooling',
        slug: 'enable-india-rej1',
        ownerEmail: 'ravi@enable.org',
        status: 'inactive',
        rejectedAt: new Date(), // just rejected → still cooling
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(409);
    const err = res.json() as { error: { code: string; fields?: { retry_after?: string } } };
    expect(err.error.code).toBe('REGISTRATION_COOLING');
    expect(err.error.fields?.retry_after).toBeTruthy();
    const stored = await orgStore.findById('o-cooling');
    expect(stored.ok && stored.value?.status).toBe('inactive');
    expect(mailer.outbox.length).toBe(0);
  });

  it('revives a rejected org once the cooling window has elapsed', async () => {
    orgStore.seed([
      buildAggregatorOrg({
        id: 'o-revive',
        slug: 'enable-india-rej2',
        displayName: 'Old Name',
        ownerEmail: 'ravi@enable.org',
        status: 'inactive',
        rejectedAt: new Date(Date.now() - 13 * 60 * 60 * 1000), // 13h ago > 12h default
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { org_id: string; status: string };
    expect(body.org_id).toBe('o-revive');
    expect(body.status).toBe('pending');
    const stored = await orgStore.findById('o-revive');
    if (stored.ok) {
      expect(stored.value?.status).toBe('pending');
      expect(stored.value?.rejectedAt).toBeNull();
      // No field overwrite on revive.
      expect(stored.value?.displayName).toBe('Old Name');
    }
    expect(mailer.outbox.length).toBe(1);
  });

  it('re-sends the coordinator invite link when the org is already ACTIVE', async () => {
    orgStore.seed([
      buildAggregatorOrg({
        id: 'o-active-owner',
        slug: 'enable-india-live',
        displayName: 'Old Name',
        ownerEmail: 'active-owner@enable.org',
        status: 'active',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'active-owner@enable.org' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { org_id: string; status: string; message: string };
    expect(body.org_id).toBe('o-active-owner');
    expect(body.status).toBe('active');
    expect(body.message).toMatch(/already registered/i);
    // The invite link is the whole point of the mail.
    expect(mailer.outbox.length).toBe(1);
    expect(mailer.outbox[0]?.subject).toMatch(/already registered/i);
    expect(mailer.outbox[0]?.html).toContain('/register/invite?grant=');
    // Nothing about the row changes — no takeover via an anonymous resubmit.
    const stored = await orgStore.findById('o-active-owner');
    expect(stored.ok && stored.value?.displayName).toBe('Old Name');
    expect(stored.ok && stored.value?.status).toBe('active');
  });

  it('throttles the invite resend per OWNER address and mints nothing', async () => {
    // Each admitted resend mints another independent 90-day grant, so the cap
    // has to be enforced before minting — not just before mailing.
    orgStore.seed([
      buildAggregatorOrg({
        id: 'o-active-throttled',
        slug: 'enable-india-live6',
        ownerEmail: 'throttled@enable.org',
        status: 'active',
      }),
    ]);
    const seen: string[] = [];
    _setOrgInviteResendRateChecker(async (email) => {
      seen.push(email);
      return { allowed: false, retryAfterSeconds: 900 };
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'throttled@enable.org' } },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('900');
    const err = res.json() as {
      error: { code: string; fields?: { retry_after_seconds?: number } };
    };
    expect(err.error.code).toBe('RATE_LIMITED');
    expect(err.error.fields?.retry_after_seconds).toBe(900);
    // No mail, and therefore no grant.
    expect(mailer.outbox.length).toBe(0);
    // Keyed on the STORED owner address, so a caller cannot pick a fresh bucket.
    expect(seen).toEqual(['throttled@enable.org']);
  });

  it('keys the resend bucket on the STORED address, not the submitted one', async () => {
    // The org form is anonymous. Keying on submitted input would let an
    // attacker rotate the payload email and get an unused bucket every time.
    orgStore.seed([
      buildAggregatorOrg({
        id: 'o-active-keyed',
        slug: 'enable-india-live7',
        ownerEmail: 'stored-owner@enable.org',
        status: 'active',
      }),
    ]);
    const seen: string[] = [];
    _setOrgInviteResendRateChecker(async (email) => {
      seen.push(email);
      return { allowed: true, retryAfterSeconds: 0 };
    });
    await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'stored-owner@enable.org' } },
    });
    expect(seen).toEqual(['stored-owner@enable.org']);
  });

  it('mails the STORED owner address, never the resubmitted one', async () => {
    // The org form is anonymous. Honouring the submitted address would hand a
    // stranger a 90-day credential that mints coordinator invites for this org.
    orgStore.seed([
      buildAggregatorOrg({
        id: 'o-active-hijack',
        slug: 'enable-india-live2',
        ownerEmail: 'real-owner@enable.org',
        status: 'active',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'real-owner@enable.org' } },
    });
    expect(res.statusCode).toBe(200);
    expect(mailer.outbox.length).toBe(1);
    expect(mailer.outbox[0]?.to).toContain('real-owner@enable.org');
  });

  it('still rejects a resubmit against a RETIRED org with OWNER_ALREADY_REGISTERED', async () => {
    // A dead org must never be handed a working credential.
    orgStore.seed([
      buildAggregatorOrg({
        id: 'o-retired-owner',
        slug: 'enable-india-dead',
        ownerEmail: 'retired-owner@enable.org',
        status: 'retired',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'retired-owner@enable.org' } },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('OWNER_ALREADY_REGISTERED');
    expect(mailer.outbox.length).toBe(0);
  });

  it('does not claim delivery when the invite mail fails', async () => {
    // The owner in this branch is one who never got the first email; telling
    // them a second is on its way when the send just failed leaves them
    // waiting instead of contacting support.
    orgStore.seed([
      buildAggregatorOrg({
        id: 'o-active-nolie',
        slug: 'enable-india-live4',
        ownerEmail: 'active-nolie@enable.org',
        status: 'active',
      }),
    ]);
    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'smtp down' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'active-nolie@enable.org' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mail_sent: boolean; message: string };
    expect(body.mail_sent).toBe(false);
    expect(body.message).toMatch(/could not be emailed/i);
    expect(body.message).not.toMatch(/has been sent/i);
  });

  it('reports mail_sent true on the happy path', async () => {
    orgStore.seed([
      buildAggregatorOrg({
        id: 'o-active-sent',
        slug: 'enable-india-live5',
        ownerEmail: 'active-sent@enable.org',
        status: 'active',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'active-sent@enable.org' } },
    });
    expect((res.json() as { mail_sent: boolean }).mail_sent).toBe(true);
  });

  it('still answers 200 for an ACTIVE org when the invite mail cannot be delivered', async () => {
    // Soft-fail, matching the approval path: the org is live either way, so a
    // mail outage must not surface as a registration failure.
    orgStore.seed([
      buildAggregatorOrg({
        id: 'o-active-mailfail',
        slug: 'enable-india-live3',
        ownerEmail: 'active-mailfail@enable.org',
        status: 'active',
      }),
    ]);
    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'smtp down' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'active-mailfail@enable.org' } },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('active');
  });

  it('rejects a second org with a case-insensitively matching name (ORG_NAME_TAKEN, 409)', async () => {
    // An existing active org already owns the name — a different owner submits
    // the same display_name (different case) and must be blocked.
    orgStore.seed([
      buildAggregatorOrg({
        id: 'o-name-owner',
        slug: 'enable-india-live',
        displayName: 'Enable India',
        ownerEmail: 'someone-else@enable.org',
        status: 'active',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, display_name: 'enable india' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ORG_NAME_TAKEN');
  });

  it('maps a DUPLICATE_SLUG store error to ORG_SLUG_TAKEN (409)', async () => {
    // A store stub that always reports a slug collision on create.
    class DupSlugStore extends AggregatorOrgStoreBase {
      async create(_i: CreateOrgInput): Promise<OrgStoreResult<AggregatorOrg>> {
        return { ok: false, error: { code: 'DUPLICATE_SLUG', message: 'taken' } };
      }
      async findById(): Promise<OrgStoreResult<AggregatorOrg | null>> {
        return { ok: true, value: null };
      }
      async findBySlug(): Promise<OrgStoreResult<AggregatorOrg | null>> {
        return { ok: true, value: null };
      }
      async findByOwnerEmail(): Promise<OrgStoreResult<AggregatorOrg | null>> {
        return { ok: true, value: null };
      }
      async listActive(): Promise<OrgStoreResult<AggregatorOrg[]>> {
        return { ok: true, value: [] };
      }
      async listPending(): Promise<OrgStoreResult<AggregatorOrg[]>> {
        return { ok: true, value: [] };
      }
      async deleteById(): Promise<OrgStoreResult<void>> {
        return { ok: true, value: undefined };
      }
      async update(): Promise<OrgStoreResult<AggregatorOrg>> {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'x' } };
      }
      async approve(): Promise<OrgStoreResult<AggregatorOrg | null>> {
        return { ok: true, value: null };
      }
      async reject(): Promise<OrgStoreResult<AggregatorOrg | null>> {
        return { ok: true, value: null };
      }
    }
    _setAggregatorOrgStore(new DupSlugStore());
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ORG_SLUG_TAKEN');
  });

  it('401s POST /v1/orgs/create without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      payload: orgBody,
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('400 INVALID_PHONE on a malformed owner phone', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, phone: 'not-a-phone' } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_PHONE');
  });

  it('429 RATE_LIMITED when the submit rate checker rejects the request', async () => {
    _setSubmitRateChecker(async () => ({ allowed: false, retryAfterSeconds: 37 }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('37');
    expect((res.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('503 DB_UNAVAILABLE when findByOwnerEmail fails', async () => {
    orgStore.findByOwnerEmail = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it('503 DB_UNAVAILABLE when orgStore.create fails with an unmapped error code', async () => {
    // NOT_FOUND is a real OrgStoreError variant, but the route only special-cases
    // DUPLICATE_NAME/DUPLICATE_SLUG — everything else (including this) falls
    // through to the generic DB_UNAVAILABLE branch.
    orgStore.create = async () => ({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'boom' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it('500 CONSENT_WRITE_FAILED (rolled back) when the consent config fails to load', async () => {
    loadConsentConfigMock.mockRejectedValueOnce(new Error('disk error'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'consent-load-fail@enable.org' } },
    });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe('CONSENT_WRITE_FAILED');
    const found = await orgStore.findByOwnerEmail('consent-load-fail@enable.org');
    expect(found.ok && found.value).toBeNull();
  });

  it('503 IDP_UNAVAILABLE (org rolled back to inactive) when the mirrored KC group create fails', async () => {
    idp.createGroup = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'group-fail@enable.org' } },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
    const found = await orgStore.findByOwnerEmail('group-fail@enable.org');
    expect(found.ok && found.value?.status).toBe('inactive');
  });

  it('409 OWNER_ALREADY_REGISTERED (rolled back to inactive) when the KC owner user already exists', async () => {
    await idp.createUser({ email: 'dup-owner@enable.org' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'dup-owner@enable.org' } },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('OWNER_ALREADY_REGISTERED');
    const found = await orgStore.findByOwnerEmail('dup-owner@enable.org');
    expect(found.ok && found.value?.status).toBe('inactive');
  });

  it('503 IDP_UNAVAILABLE (org rolled back to inactive) when KC owner user creation fails for another reason', async () => {
    idp.createUser = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'user-create-fail@enable.org' } },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
    const found = await orgStore.findByOwnerEmail('user-create-fail@enable.org');
    expect(found.ok && found.value?.status).toBe('inactive');
  });

  it('503 DB_UNAVAILABLE when the final stamp update (kcGroupId/ownerKcSub) fails', async () => {
    const originalUpdate = orgStore.update.bind(orgStore);
    let calls = 0;
    orgStore.update = async (id, patch) => {
      calls++;
      if (calls === 1) return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } };
      return originalUpdate(id, patch);
    };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'stamp-fail@enable.org' } },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it('401s GET /v1/orgs without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/orgs' });
    expect(res.statusCode).toBe(401);
  });

  it('503 DB_UNAVAILABLE when GET /v1/orgs listActive fails', async () => {
    orgStore.listActive = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/orgs', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });
});
