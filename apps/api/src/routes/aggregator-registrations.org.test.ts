// Coordinator submit with the org hierarchy ON. Flag must be set before any
// import that pulls in `config`.
process.env.ORG_HIERARCHY_ENABLED = 'true';

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { AggregatorStoreFake, _setAggregatorStore } from '../services/aggregator-store/index.js';
import {
  AggregatorProfileStoreFake,
  _setAggregatorProfileStore,
} from '../services/aggregator-profile-store/index.js';
import {
  AggregatorOrgStoreFake,
  buildAggregatorOrg,
  _setAggregatorOrgStore,
} from '../services/aggregator-org-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '../services/mailer/index.js';
import { _resetTokenKey } from '../services/approval-token.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setSubmitRateChecker } from '../services/submit-rate.js';

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('coordinator submit with ORG_HIERARCHY_ENABLED', () => {
  let app: FastifyInstance;
  let aggregatorStore: AggregatorStoreFake;
  let orgStore: AggregatorOrgStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;

  const validBody = {
    name: 'TRRAIN',
    type: 'seeker',
    contact: { name: 'Asha Kumari', phone: '+919876543210', email: 'asha@trrain.org' },
    consent: { value: true, given_at: '2026-01-15T10:00:00Z', valid_till: '2027-01-15T10:00:00Z' },
  };

  beforeEach(async () => {
    _resetTokenKey();
    _resetJwks();
    _setSubmitRateChecker(null);
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.ADMIN_EMAILS = 'reviewer@bluedots.local';
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';

    aggregatorStore = new AggregatorStoreFake();
    orgStore = new AggregatorOrgStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();

    _setAggregatorStore(aggregatorStore);
    _setAggregatorProfileStore(new AggregatorProfileStoreFake());
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
    _setAggregatorStore(null);
    _setAggregatorProfileStore(null);
    _setAggregatorOrgStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setAccessTokenVerifier(null);
    _setSubmitRateChecker(null);
  });

  it('rejects coordinator submit when no active org exists (bootstrap)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, org_id: 'missing' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('TARGET_ORG_INACTIVE');
  });

  it('rejects coordinator submit when org_id is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(400);
  });

  it('sets parent_org_id from the chosen active org', async () => {
    orgStore.seed([
      buildAggregatorOrg({ id: 'org-1', slug: 'o', status: 'active', ownerEmail: 'owner@o.org' }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, org_id: 'org-1' },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { aggregator_id: string }).aggregator_id;
    const stored = await aggregatorStore.findById(id);
    expect(stored.ok && stored.value?.parentOrgId).toBe('org-1');
  });

  it('returns OWNER_ALREADY_REGISTERED when the coordinator email is an org owner', async () => {
    orgStore.seed([
      buildAggregatorOrg({
        id: 'org-1',
        slug: 'o',
        status: 'active',
        ownerEmail: 'asha@trrain.org',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, org_id: 'org-1' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('OWNER_ALREADY_REGISTERED');
  });

  it('throttles a submit when the rate checker denies (429)', async () => {
    orgStore.seed([
      buildAggregatorOrg({ id: 'org-1', slug: 'o', status: 'active', ownerEmail: 'owner@o.org' }),
    ]);
    _setSubmitRateChecker(async () => ({ allowed: false, retryAfterSeconds: 42 }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, org_id: 'org-1' },
    });
    expect(res.statusCode).toBe(429);
  });
});
