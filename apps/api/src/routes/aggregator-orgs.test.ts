// The org-hierarchy routes are flag-gated; `config` reads env once at import,
// so the flag must be set before any import that pulls in `config`.
process.env.ORG_HIERARCHY_ENABLED = 'true';

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
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
import { FakeMailer, _setMailer } from '../services/mailer/index.js';
import { _resetTokenKey } from '../services/approval-token.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('aggregator-orgs routes', () => {
  let app: FastifyInstance;
  let orgStore: AggregatorOrgStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;

  beforeEach(async () => {
    _resetTokenKey();
    _resetJwks();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.ADMIN_EMAILS = 'reviewer@bluedots.local';
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';

    orgStore = new AggregatorOrgStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();

    _setAggregatorOrgStore(orgStore);
    _setIdpAdmin(idp);
    _setMailer(mailer);
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
    _setAccessTokenVerifier(null);
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
    expect(stored.ok && stored.value?.ownerKcSub).toBeTruthy();
    // Owner KC user created disabled.
    const owner = await idp.findByEmail('ravi@enable.org');
    expect(owner.ok && owner.value?.enabled).toBe(false);
    // A review email went to the network admin.
    expect(mailer.outbox.length).toBe(1);
    expect(mailer.outbox[0]?.to).toContain('reviewer@bluedots.local');
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
});
