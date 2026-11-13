// Org registration + dropdown routes (always registered since 0028).

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  buildDefaultOrg,
  _setOrganisationStore,
  OrganisationStoreBase,
  type Organisation,
  type CreateOrgInput,
  type OrgStoreResult,
} from '../services/organisation-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../services/user-store/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { randomUUID } from 'node:crypto';
import {
  RegistrationInvitesStoreFake,
  buildRegistrationInvite,
  _setRegistrationInvitesStore,
} from '../services/registration-invites-store/index.js';
import { mintInviteToken, _resetInviteTokenKey } from '../services/invite-token.js';
import { _setConsentLedger } from '../services/consent-ledger/index.js';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { _setSubmitRateChecker } from '../services/submit-rate.js';
import type * as ConfigLoaderFs from '@aggregator-dpg/config-loader/fs';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { _setNetworkConfig } from '../services/network-config.js';
import { _resetOrgSchemaValidator } from '../services/org-schema-validator.js';

const { loadConsentConfigMock } = vi.hoisted(() => ({ loadConsentConfigMock: vi.fn() }));
vi.mock('@aggregator-dpg/config-loader/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigLoaderFs>();
  return { ...actual, loadConsentConfig: loadConsentConfigMock };
});

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('aggregator-orgs routes', () => {
  let app: FastifyInstance;
  let orgStore: OrganisationStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;
  let consentLedger: ConsentLedgerFake;
  let userStore: UserStoreFake;
  let invites: RegistrationInvitesStoreFake;

  /**
   * Accepts an org invite for the body's owner email, under `parent_id` or the network root.
   */
  async function acceptInvite(payload: Record<string, unknown>) {
    const { parent_id: parentId, ...body } = payload;
    const owner = body['owner'];
    const email =
      typeof owner === 'object' &&
      owner !== null &&
      'email' in owner &&
      typeof owner.email === 'string'
        ? owner.email.toLowerCase()
        : '';
    const root = await orgStore.findRoot();
    const parent = typeof parentId === 'string' ? parentId : root.ok ? (root.value?.id ?? '') : '';
    const jti = randomUUID();
    invites.seed([
      buildRegistrationInvite({
        jti,
        role: 'org_owner',
        parentOrgId: parent,
        email,
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ]);
    const { token } = await mintInviteToken({ jti, role: 'org_owner', org: parent, email });
    return app.inject({
      method: 'POST',
      url: '/v1/org/invite/accept',
      headers: AUTH_HEADER,
      payload: { ...body, invite: token },
    });
  }

  beforeEach(async () => {
    _resetInviteTokenKey();
    _resetJwks();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.ADMIN_EMAILS = 'reviewer@bluedots.local';
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    orgStore = new OrganisationStoreFake();
    orgStore.seedRoot(
      buildOrganisation({
        id: '00000000-0000-4000-8000-0000000000f0',
        slug: 'network',
        displayName: 'Blue Dots Network',
        status: 'active',
        depth: 0,
      }),
    );
    invites = new RegistrationInvitesStoreFake();
    _setRegistrationInvitesStore(invites);
    idp = new IdpAdminFake();
    mailer = new FakeMailer();
    consentLedger = new ConsentLedgerFake();

    // Permissive by default, NOT `null`. `null` restores the Redis-backed
    // limiter, whose bucket is keyed `ip|email` — constant across this file —
    // so submits past the window cap 429 and which tests fail depends on the
    // wall clock. Cases that assert throttling install their own denier.
    _setSubmitRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    // Allow by default; the throttle cases override per-test.
    loadConsentConfigMock.mockReset();
    const actualLoader = await vi.importActual<typeof ConfigLoaderFs>(
      '@aggregator-dpg/config-loader/fs',
    );
    loadConsentConfigMock.mockImplementation(actualLoader.loadConsentConfig);

    userStore = new UserStoreFake();
    _setUserStore(userStore);
    _setOrganisationStore(orgStore);
    _setNetworkConfig(buildBlueDotConfig());
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

  // A test may switch the deployment's network/brand; always switch it back.
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetOrgSchemaValidator();
  });

  afterAll(async () => {
    await app?.close();
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setConsentLedger(null);
    _setAccessTokenVerifier(null);
    _setSubmitRateChecker(null);
    _setNetworkConfig(null);
  });

  const orgBody = {
    display_name: 'Enable India',
    state: 'Karnataka',
    owner: { name: 'Ravi Kumar', email: 'ravi@enable.org', phone: '+919876500000' },
    consent: { value: true, given_at: '2026-01-15T10:00:00Z', valid_till: '2099-01-15T10:00:00Z' },
  };

  describe('one person per email/phone across coordinators and org owners (contact, 0025)', () => {
    it('409 USER_EXISTS before any write when a coordinator holds the owner email', async () => {
      userStore.seed([
        buildCoordinator({
          contact: { name: 'Ravi', email: 'ravi@enable.org', phone: '+919999900000' },
        }),
      ]);
      const res = await acceptInvite(orgBody);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('USER_EXISTS');
      // Nothing half-provisioned: no org row, no KC group, no KC user.
      const orgs = await orgStore.listPending();
      expect(orgs.ok && orgs.value).toEqual([]);
      expect(idp.getGroup('grp-1')).toBeUndefined();
    });

    it('409 PHONE_EXISTS when a coordinator holds the owner phone', async () => {
      userStore.seed([
        buildCoordinator({
          contact: { name: 'Someone', email: 'someone@else.org', phone: '+919876500000' },
        }),
      ]);
      const res = await acceptInvite(orgBody);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
    });

    it("409 PHONE_EXISTS when another org's owner holds the phone", async () => {
      orgStore.seed([
        buildOrganisation({
          id: 'o-other',
          slug: 'other-org',
          displayName: 'Other Org',
          ownerEmail: 'boss@other.org',
          ownerPhone: '+919876500000',
          status: 'active',
        }),
      ]);
      const res = await acceptInvite(orgBody);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
    });

    it('persists the owner name on create', async () => {
      const res = await acceptInvite(orgBody);
      expect(res.statusCode).toBe(201);
      const created = await orgStore.findByOwnerEmail('ravi@enable.org');
      expect(created.ok && created.value?.ownerName).toBe('Ravi Kumar');
    });
  });

  it('creates a pending org + mirrored group + an owner who signs in with an email code, mailing nobody', async () => {
    const res = await acceptInvite(orgBody);
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
    const owner = await idp.findByEmail('ravi@enable.org');
    expect(owner.ok && owner.value).toMatchObject({ enabled: true, emailVerified: false });
    expect(mailer.outbox).toHaveLength(0);

    // Consent ledger should have one row for the org
    const ledgerRows = consentLedger.list();
    expect(ledgerRows).toHaveLength(1);
    const consentRow = ledgerRows[0];
    expect(consentRow?.subjectType).toBe('organisation');
    expect(consentRow?.subjectId).toBe(body.org_id);
    expect(consentRow?.termsVersion).toBeGreaterThanOrEqual(1);
    expect(consentRow?.privacyVersion).toBeGreaterThanOrEqual(1);
    expect(consentRow?.source).toBe('registration');
    // network/brand must come from AGGREGATOR_NETWORK/AGGREGATOR_BRAND so the
    // recorded version matches what the web layer displayed.
    expect(consentRow?.network).toBe('blue_dot'); // default when AGGREGATOR_NETWORK unset
    expect(consentRow?.brand).toBeNull(); // default when AGGREGATOR_BRAND unset
  });

  // The schema-driven fields are per-network: each deployment's
  // org-registration JSON Schema owns its own closed set for
  // `organisation_type` (UP-GZB educational/non_educational, ALIMCO
  // ngo/government_entity/…) and the form validates the answer against it.
  // A zod enum here pinned one network's list and rejected every other
  // network's valid form with a 400, so the value must round-trip as given.
  it('accepts a network-specific organisation_type and stores the schema-driven fields', async () => {
    // A brand schema that declares `organisation_type` (purple_dot / alimco).
    vi.stubEnv('AGGREGATOR_NETWORK', 'purple_dot');
    vi.stubEnv('AGGREGATOR_BRAND', 'alimco');
    _resetOrgSchemaValidator();
    const res = await acceptInvite({
      ...orgBody,
      aggregator_type: ['seeker'],
      organisation_type: 'ngo',
      website: 'https://enable.org',
    });
    expect(res.statusCode).toBe(201);
    const { org_id } = res.json() as { org_id: string };
    const stored = await orgStore.findById(org_id);
    const profile = (stored.ok ? stored.value?.profile : undefined) as
      Record<string, unknown> | undefined;
    expect(profile?.['organisation_type']).toBe('ngo');
    expect(profile?.['aggregator_type']).toEqual(['seeker']);
    expect(profile?.['website']).toBe('https://enable.org');
  });

  it('stores the default schema fields in profile, GSTIN upper-cased', async () => {
    const res = await acceptInvite({
      ...orgBody,
      website: 'https://enable.org',
      gst_number: '29abcde1234f1zw',
      domains: ['seeker'],
      // Not in the default schema: dropped, not stored.
      organisation_type: 'ngo',
    });
    expect(res.statusCode).toBe(201);
    const stored = await orgStore.findById((res.json() as { org_id: string }).org_id);
    const profile = stored.ok ? stored.value?.profile : undefined;
    expect(profile).toMatchObject({
      website: 'https://enable.org',
      gst_number: '29ABCDE1234F1ZW',
      domains: ['seeker'],
    });
    expect(profile?.['organisation_type']).toBeUndefined();
  });

  it('refuses a bad schema field with field_errors, creating nothing', async () => {
    const res = await acceptInvite({
      ...orgBody,
      website: 'http://enable.org',
      gst_number: '29ABCDE1234F1Z5',
      domains: ['astronaut'],
    });
    expect(res.statusCode).toBe(400);
    const error = (res.json() as { error: { code: string; fields: { field_errors: object } } })
      .error;
    expect(error.code).toBe('SCHEMA_VALIDATION');
    expect(Object.keys(error.fields.field_errors).sort()).toEqual([
      'domains',
      'gst_number',
      'website',
    ]);
    expect((error.fields.field_errors as Record<string, string>)['website']).toBe(
      'Please enter a website starting with https://',
    );
  });

  it('records org consent in the ledger on successful registration', async () => {
    const res = await acceptInvite(orgBody);
    expect(res.statusCode).toBe(201);
    const { org_id } = res.json() as { org_id: string };

    const ledgerRows = consentLedger.list();
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.subjectType).toBe('organisation');
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

    const res = await acceptInvite({
      ...orgBody,
      owner: { ...orgBody.owner, email: 'ledger-fail@enable.org' },
    });
    // Fail-closed: the org path has no fallback, so a consent-write failure
    // rolls the registration back rather than returning 201.
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('CONSENT_WRITE_FAILED');
    // One transaction (0029): no org and no owner remain, and Keycloak was
    // never reached.
    const owner = await orgStore.findByOwnerEmail('ledger-fail@enable.org');
    expect(owner.ok && owner.value).toBeNull();
    const kc = await idp.findByEmail('ledger-fail@enable.org');
    expect(kc.ok && kc.value).toBeNull();
  });

  it.each([
    // A month from now: always inside the window, whatever the run date.
    ['a date within the window', new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(), false],
    ['a date beyond the ceiling', '2099-01-01T00:00:00Z', true],
    ['an unparseable value', 'not-a-date', true],
  ])(
    'stores the org consent valid_till on the ledger row: %s',
    async (_label, validTill, clamped) => {
      const email = `till-${validTill.slice(0, 4)}@enable.org`;
      const res = await acceptInvite({
        ...orgBody,
        display_name: `Till ${validTill.slice(0, 7)}`,
        owner: {
          ...orgBody.owner,
          email,
          phone: `+9198765${String(validTill.length).padStart(5, '0')}`,
        },
        consent: { ...orgBody.consent, valid_till: validTill },
      });
      expect(res.statusCode).toBe(201);
      const { org_id } = res.json() as { org_id: string };
      const row = consentLedger.list().find((r) => r.subjectId === org_id);
      expect(row?.subjectType).toBe('organisation');
      const stored = row?.validTill?.getTime() ?? 0;
      if (clamped) {
        const ceiling = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000;
        expect(Math.abs(stored - ceiling)).toBeLessThan(60_000);
      } else {
        expect(stored).toBe(new Date(validTill).getTime());
      }
    },
  );

  it('400 SCHEMA_VALIDATION for an org consent that is already expired', async () => {
    const res = await acceptInvite({
      ...orgBody,
      owner: { ...orgBody.owner, email: 'expired@enable.org' },
      consent: { ...orgBody.consent, valid_till: '2020-01-01T00:00:00Z' },
    });
    expect(res.statusCode).toBe(400);
    const owner = await orgStore.findByOwnerEmail('expired@enable.org');
    expect(owner.ok && owner.value).toBeNull();
  });

  describe('parent org (org nesting)', () => {
    const ROOT_ID = '00000000-0000-4000-8000-0000000000f0';
    const STATE_ID = '00000000-0000-4000-8000-0000000000f1';
    const root = buildOrganisation({
      id: ROOT_ID,
      slug: 'network',
      displayName: 'Blue Dots Network',
      ownerEmail: 'nf@test.local',
      status: 'active',
      depth: 0,
    });
    const state = buildOrganisation({
      id: STATE_ID,
      slug: 'state',
      displayName: 'State Org',
      ownerEmail: 'state@test.local',
      status: 'active',
      parentId: ROOT_ID,
      knownAs: 'state',
    });
    const create = (payload: Record<string, unknown>) => acceptInvite(payload);
    const storedParent = async (orgId: string) => {
      const r = await orgStore.findById(orgId);
      return r.ok ? r.value?.parentId : undefined;
    };

    const setHierarchy = (hierarchy: {
      max_depth: number;
      max_children?: number;
      max_total_orgs: number;
    }) => {
      const base = buildBlueDotConfig();
      _setNetworkConfig(
        buildBlueDotConfig({
          aggregator: {
            ...base.aggregator,
            organisation: { hierarchy },
          },
        }),
      );
    };
    const errorOf = (res: { json: () => unknown }) =>
      (res.json() as { error: { code: string; fields?: Record<string, unknown> } }).error;
    const district = buildOrganisation({
      id: '00000000-0000-4000-8000-0000000000f5',
      slug: 'district-a',
      displayName: 'District A',
      ownerEmail: 'district-a@test.local',
      status: 'active',
      parentId: STATE_ID,
      knownAs: 'district',
      depth: 2,
    });

    beforeEach(() => {
      orgStore.seedRoot(root);
      orgStore.seed([state]);
      orgStore.seedKnownAsValues(ROOT_ID, [{ key: 'state', name: 'State', default: true }]);
      orgStore.seedKnownAsValues(STATE_ID, [
        { key: 'block', name: 'Block' },
        { key: 'district', name: 'District', default: true },
      ]);
      setHierarchy({ max_depth: 3, max_total_orgs: 50 });
    });

    it('puts the org under the root when parent_id is omitted, at depth 1', async () => {
      const res = await create(orgBody);
      expect(res.statusCode).toBe(201);
      const orgId = (res.json() as { org_id: string }).org_id;
      expect(await storedParent(orgId)).toBe(ROOT_ID);
      const stored = await orgStore.findById(orgId);
      expect(stored.ok && stored.value?.knownAs).toBe('state');
    });

    it('gives the system value under a parent with no default', async () => {
      const aggId = '00000000-0000-4000-8000-0000000000f3';
      orgStore.seed([
        buildOrganisation({
          id: aggId,
          slug: 'agg',
          displayName: 'Agg Org',
          ownerEmail: 'agg@test.local',
          status: 'active',
          knownAs: 'aggregator',
          depth: 2,
        }),
      ]);
      const res = await create({ ...orgBody, parent_id: aggId });
      expect(res.statusCode).toBe(201);
      const stored = await orgStore.findById((res.json() as { org_id: string }).org_id);
      expect(stored.ok && stored.value?.knownAs).toBe('aggregator');
    });

    it('puts the org under the inviting parent and keeps parent_id out of the profile', async () => {
      const res = await create({ ...orgBody, parent_id: STATE_ID });
      expect(res.statusCode).toBe(201);
      const orgId = (res.json() as { org_id: string }).org_id;
      expect(await storedParent(orgId)).toBe(STATE_ID);
      const stored = await orgStore.findById(orgId);
      expect(stored.ok && stored.value?.profile).not.toHaveProperty('parent_id');
      // The parent's default value.
      expect(stored.ok && stored.value?.knownAs).toBe('district');
    });

    it.each([
      ['an unknown org', '00000000-0000-4000-8000-0000000000ff'],
      ['the Default org', buildDefaultOrg().id],
    ])(
      '409 TARGET_ORG_INACTIVE for an invite from %s, creating nothing',
      async (_label, parentId) => {
        orgStore.seed([buildDefaultOrg()]);
        const createGroup = vi.spyOn(idp, 'createGroup');
        const res = await create({ ...orgBody, parent_id: parentId });
        expect(res.statusCode).toBe(409);
        expect(errorOf(res).code).toBe('TARGET_ORG_INACTIVE');
        const owner = await orgStore.findByOwnerEmail(orgBody.owner.email);
        expect(owner.ok && owner.value).toBeNull();
        expect(createGroup).not.toHaveBeenCalled();
      },
    );

    it('creates under a nested parent with no list as aggregator', async () => {
      orgStore.seed([district]);
      const res = await create({ ...orgBody, parent_id: district.id });
      expect(res.statusCode).toBe(201);
      const stored = await orgStore.findById((res.json() as { org_id: string }).org_id);
      expect(stored.ok && stored.value).toMatchObject({
        parentId: district.id,
        depth: 3,
        knownAs: 'aggregator',
      });
    });

    it('409 ORG_DEPTH_LIMIT with fields.parent_id when the parent is at max_depth', async () => {
      setHierarchy({ max_depth: 1, max_total_orgs: 50 });
      const createGroup = vi.spyOn(idp, 'createGroup');
      const res = await create({ ...orgBody, parent_id: STATE_ID });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'ORG_DEPTH_LIMIT',
        fields: { parent_id: STATE_ID },
      });
      expect(createGroup).not.toHaveBeenCalled();
    });

    it('409 ORG_CHILD_LIMIT with fields.parent_id when the parent is full', async () => {
      setHierarchy({ max_depth: 3, max_children: 1, max_total_orgs: 50 });
      orgStore.seed([district]);
      const res = await create({ ...orgBody, parent_id: STATE_ID });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'ORG_CHILD_LIMIT',
        fields: { parent_id: STATE_ID },
      });
    });

    it('409 ORG_CHILD_LIMIT with a null parent_id when the root is full and none was given', async () => {
      setHierarchy({ max_depth: 3, max_children: 1, max_total_orgs: 50 });
      const res = await create(orgBody);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'ORG_CHILD_LIMIT',
        fields: { parent_id: null },
      });
    });

    it('409 ORG_TOTAL_LIMIT when the instance holds max_total_orgs', async () => {
      setHierarchy({ max_depth: 3, max_total_orgs: 1 });
      const res = await create(orgBody);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('ORG_TOTAL_LIMIT');
    });
  });

  it("stores the form's website and address as the org's url and location (0028)", async () => {
    const res = await acceptInvite({
      ...orgBody,
      website: 'https://enable.example',
      address: { streetAddress: '1 Main Rd', addressLocality: 'Bengaluru' },
      coordinates: [77.59, 12.97],
    });
    expect(res.statusCode).toBe(201);
    const created = await orgStore.findById((res.json() as { org_id: string }).org_id);
    // The website is a schema field: it lives in `profile`, not a column.
    expect(created.ok && created.value?.profile['website']).toBe('https://enable.example');
    expect(created.ok && created.value?.locations).toEqual([
      {
        geo: { type: 'Point', coordinates: [77.59, 12.97] },
        address: {
          streetAddress: '1 Main Rd',
          addressLocality: 'Bengaluru',
          addressRegion: 'Karnataka',
        },
      },
    ]);
  });

  it("keeps the form's full address in profile, district included", async () => {
    const address = {
      streetAddress: '1 Main Rd',
      addressLocality: 'Bengaluru',
      addressDistrict: 'Bengaluru Urban',
      addressRegion: 'Karnataka',
      postalCode: '560001',
      addressCountry: 'IN',
    };
    const res = await acceptInvite({ ...orgBody, address, coordinates: [77.59, 12.97] });
    expect(res.statusCode).toBe(201);
    const created = await orgStore.findById((res.json() as { org_id: string }).org_id);
    const profile = created.ok ? created.value?.profile : undefined;
    expect(profile?.['address']).toEqual(address);
    expect(profile?.['coordinates']).toEqual([77.59, 12.97]);
  });

  it('stores no address in profile when the form sends none', async () => {
    const res = await acceptInvite(orgBody);
    expect(res.statusCode).toBe(201);
    const created = await orgStore.findById((res.json() as { org_id: string }).org_id);
    expect(created.ok && created.value?.profile).not.toHaveProperty('address');
  });

  it('retries a colliding random slug instead of failing (review A11)', async () => {
    let calls = 0;
    const realCreate = orgStore.create.bind(orgStore);
    orgStore.create = async (input, rules) => {
      calls += 1;
      if (calls === 1) return { ok: false, error: { code: 'DUPLICATE_SLUG', message: 'taken' } };
      return realCreate(input, rules);
    };
    const res = await acceptInvite(orgBody);
    expect(res.statusCode).toBe(201);
    expect(calls).toBe(2);
  });

  it('rejects org registration when consent.value is false (400/validation)', async () => {
    const res = await acceptInvite({ ...orgBody, consent: { ...orgBody.consent, value: false } });
    expect(res.statusCode).toBe(400);
  });

  it('still rejects a resubmit against a RETIRED org with OWNER_ALREADY_REGISTERED', async () => {
    // A dead org must never be handed a working credential.
    orgStore.seed([
      buildOrganisation({
        id: 'o-retired-owner',
        slug: 'enable-india-dead',
        ownerEmail: 'retired-owner@enable.org',
        status: 'retired',
      }),
    ]);
    const res = await acceptInvite({
      ...orgBody,
      owner: { ...orgBody.owner, email: 'retired-owner@enable.org' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('OWNER_ALREADY_REGISTERED');
    expect(mailer.outbox.length).toBe(0);
  });

  it('rejects a second org with a case-insensitively matching name (ORG_NAME_TAKEN, 409)', async () => {
    // An existing active org already owns the name — a different owner submits
    // the same display_name (different case) and must be blocked.
    orgStore.seed([
      buildOrganisation({
        id: 'o-name-owner',
        slug: 'enable-india-live',
        displayName: 'Enable India',
        ownerEmail: 'someone-else@enable.org',
        status: 'active',
      }),
    ]);
    const res = await acceptInvite({ ...orgBody, display_name: 'enable india' });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ORG_NAME_TAKEN');
  });

  it('maps a DUPLICATE_SLUG store error to ORG_SLUG_TAKEN (409)', async () => {
    // A store stub that always reports a slug collision on create.
    class DupSlugStore extends OrganisationStoreBase {
      async create(_i: CreateOrgInput): Promise<OrgStoreResult<Organisation>> {
        return { ok: false, error: { code: 'DUPLICATE_SLUG', message: 'taken' } };
      }
      async findById(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async findBySlug(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async findDefault(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async findRoot(): Promise<OrgStoreResult<Organisation | null>> {
        return {
          ok: true,
          value: buildOrganisation({
            id: '00000000-0000-4000-8000-0000000000f0',
            status: 'active',
            depth: 0,
          }),
        };
      }
      async ownerIsShared(): Promise<OrgStoreResult<boolean>> {
        return { ok: true, value: false };
      }
      async findByOwnerEmail(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async findByOwnerPhone(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async listActive(): Promise<OrgStoreResult<Organisation[]>> {
        return { ok: true, value: [] };
      }
      async listPending(): Promise<OrgStoreResult<Organisation[]>> {
        return { ok: true, value: [] };
      }
      async deleteById(): Promise<OrgStoreResult<void>> {
        return { ok: true, value: undefined };
      }
      async update(): Promise<OrgStoreResult<Organisation>> {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'x' } };
      }
      async approve(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async reject(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async listOwnedBy(): Promise<OrgStoreResult<Organisation[]>> {
        return { ok: true, value: [] };
      }
      async descendantIds(): Promise<OrgStoreResult<string[]>> {
        return { ok: true, value: [] };
      }
      async childIds(): Promise<OrgStoreResult<string[]>> {
        return { ok: true, value: [] };
      }
      async setKnownAs(): Promise<OrgStoreResult<Organisation>> {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'x' } };
      }
      async setKnownAsValues(): Promise<
        OrgStoreResult<{ org: Organisation; values: []; resetCount: number }>
      > {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'x' } };
      }
      async knownAsValues(): Promise<OrgStoreResult<[]>> {
        return { ok: true, value: [] };
      }
      async defaultKnownAsNames(): Promise<OrgStoreResult<Record<string, string>>> {
        return { ok: true, value: {} };
      }
      async countStaleKnownAs(): Promise<OrgStoreResult<number>> {
        return { ok: true, value: 0 };
      }
      async search(): Promise<OrgStoreResult<{ rows: Organisation[]; nextCursor: null }>> {
        return { ok: true, value: { rows: [], nextCursor: null } };
      }
      async deleteIfPending(): Promise<OrgStoreResult<'not_pending'>> {
        return { ok: true, value: 'not_pending' };
      }
      async move(): Promise<
        OrgStoreResult<{ org: Organisation; oldParentId: string | null; movedCount: number }>
      > {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'x' } };
      }
      async parentOptions(): Promise<OrgStoreResult<{ subtreeSize: number; options: [] }>> {
        return { ok: true, value: { subtreeSize: 1, options: [] } };
      }
      async childCounts(): Promise<OrgStoreResult<Record<string, number>>> {
        return { ok: true, value: {} };
      }
      async countTotal(): Promise<OrgStoreResult<number>> {
        return { ok: true, value: 0 };
      }
    }
    _setOrganisationStore(new DupSlugStore());
    const res = await acceptInvite(orgBody);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ORG_SLUG_TAKEN');
  });

  it.each([
    ['DUPLICATE_EMAIL', 'USER_EXISTS'],
    ['DUPLICATE_PHONE', 'PHONE_EXISTS'],
  ] as const)(
    'maps a %s store error (a race past the pre-check) to %s (409)',
    async (storeCode, httpCode) => {
      const racing = new OrganisationStoreFake();
      const root = await orgStore.findRoot();
      if (root.ok && root.value) racing.seedRoot(root.value);
      racing.create = async () => ({ ok: false, error: { code: storeCode, message: 'race' } });
      _setOrganisationStore(racing);
      const res = await acceptInvite(orgBody);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe(httpCode);
    },
  );

  it('401s an invite accept without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/org/invite/accept',
      payload: { ...orgBody, invite: 'tok' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('400 INVALID_PHONE on a malformed owner phone', async () => {
    const res = await acceptInvite({
      ...orgBody,
      owner: { ...orgBody.owner, phone: 'not-a-phone' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_PHONE');
  });

  it('429 RATE_LIMITED when the submit rate checker rejects the request', async () => {
    _setSubmitRateChecker(async () => ({ allowed: false, retryAfterSeconds: 37 }));
    const res = await acceptInvite(orgBody);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('37');
    expect((res.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('503 DB_UNAVAILABLE when findByOwnerEmail fails', async () => {
    orgStore.findByOwnerEmail = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await acceptInvite(orgBody);
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it.each(['findByContactEmail', 'findByContactPhone', 'findByOwnerPhone'] as const)(
    '503 DB_UNAVAILABLE (nothing written) when the owner-contact pre-check %s fails',
    async (method) => {
      const down = () =>
        Promise.resolve({
          ok: false as const,
          error: { code: 'DB_UNAVAILABLE' as const, message: 'db down' },
        });
      if (method === 'findByOwnerPhone') orgStore.findByOwnerPhone = down;
      else userStore[method] = down;
      const res = await acceptInvite(orgBody);
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
      expect(await orgStore.findByOwnerEmail('ravi@enable.org')).toEqual({ ok: true, value: null });
    },
  );

  it('503 DB_UNAVAILABLE when orgStore.create fails with an unmapped error code', async () => {
    // NOT_FOUND is a real OrgStoreError variant, but the route only special-cases
    // DUPLICATE_NAME/DUPLICATE_SLUG — everything else (including this) falls
    // through to the generic DB_UNAVAILABLE branch.
    orgStore.create = async () => ({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'boom' },
    });
    const res = await acceptInvite(orgBody);
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it('500 CONSENT_WRITE_FAILED (rolled back) when the consent config fails to load', async () => {
    loadConsentConfigMock.mockRejectedValueOnce(new Error('disk error'));
    const res = await acceptInvite({
      ...orgBody,
      owner: { ...orgBody.owner, email: 'consent-load-fail@enable.org' },
    });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe('CONSENT_WRITE_FAILED');
    const found = await orgStore.findByOwnerEmail('consent-load-fail@enable.org');
    expect(found.ok && found.value).toBeNull();
  });

  it('503 IDP_UNAVAILABLE (half-created org deleted) when the mirrored KC group create fails', async () => {
    idp.createGroup = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await acceptInvite({
      ...orgBody,
      owner: { ...orgBody.owner, email: 'group-fail@enable.org' },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
    const found = await orgStore.findByOwnerEmail('group-fail@enable.org');
    // Deleted, not parked inactive: a row that never got a Keycloak owner
    // would keep the owner's contact and block a retry with PHONE_EXISTS.
    expect(found.ok && found.value).toBeNull();
  });

  it('409 USER_EXISTS (half-created org + group deleted) when the KC owner user already exists', async () => {
    await idp.createUser({ email: 'dup-owner@enable.org' });
    const res = await acceptInvite({
      ...orgBody,
      owner: { ...orgBody.owner, email: 'dup-owner@enable.org' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('USER_EXISTS');
    const found = await orgStore.findByOwnerEmail('dup-owner@enable.org');
    // Deleted, not parked inactive: a row that never got a Keycloak owner
    // would keep the owner's contact and block a retry with PHONE_EXISTS.
    expect(found.ok && found.value).toBeNull();
    expect(idp.getGroup('grp-1')).toBeUndefined();
  });

  it('400 NAME_INVALID_CHARACTERS (half-created org deleted) when the IdP refuses the owner name', async () => {
    idp.createUser = async () => ({
      ok: false,
      error: { code: 'INVALID_NAME', message: 'name has a refused character' },
    });
    const res = await acceptInvite({
      ...orgBody,
      owner: { ...orgBody.owner, name: 'Ravi (Ops)', email: 'bad-name@enable.org' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NAME_INVALID_CHARACTERS');
    const found = await orgStore.findByOwnerEmail('bad-name@enable.org');
    expect(found.ok && found.value).toBeNull();
  });

  it('503 IDP_UNAVAILABLE (half-created org + group deleted) when KC owner user creation fails for another reason', async () => {
    idp.createUser = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await acceptInvite({
      ...orgBody,
      owner: { ...orgBody.owner, email: 'user-create-fail@enable.org' },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
    const found = await orgStore.findByOwnerEmail('user-create-fail@enable.org');
    // Deleted, not parked inactive: a row that never got a Keycloak owner
    // would keep the owner's contact and block a retry with PHONE_EXISTS.
    expect(found.ok && found.value).toBeNull();
  });

  it('still reports the original failure when cleaning up the half-created org fails too', async () => {
    idp.createUser = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    let groupDeletes = 0;
    idp.deleteGroup = async () => {
      groupDeletes++;
      return { ok: false, error: { code: 'IDP_UNAVAILABLE', message: 'kc down' } };
    };
    let rowDeletes = 0;
    orgStore.deleteById = async () => {
      rowDeletes++;
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } };
    };
    const res = await acceptInvite({
      ...orgBody,
      owner: { ...orgBody.owner, email: 'cleanup-fail@enable.org' },
    });
    // Cleanup is best-effort and logged; it never masks the error that caused it.
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
    expect(groupDeletes).toBe(1);
    expect(rowDeletes).toBe(1);
  });

  it('503 DB_UNAVAILABLE when the final stamp update (kcGroupId/ownerKcSub) fails', async () => {
    const originalUpdate = orgStore.update.bind(orgStore);
    let calls = 0;
    orgStore.update = async (id, patch) => {
      calls++;
      if (calls === 1) return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } };
      return originalUpdate(id, patch);
    };
    const res = await acceptInvite({
      ...orgBody,
      owner: { ...orgBody.owner, email: 'stamp-fail@enable.org' },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
    // Rolled back completely: no org row, no stranded Keycloak owner user, so
    // the same owner can register again.
    const org = await orgStore.findByOwnerEmail('stamp-fail@enable.org');
    expect(org.ok && org.value).toBeNull();
    const kc = await idp.findByEmail('stamp-fail@enable.org');
    expect(kc.ok && kc.value).toBeNull();
  });
});
