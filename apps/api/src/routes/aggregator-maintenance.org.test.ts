// Stale-pending cleanup with the org hierarchy ON. Flag must be set before any
// import that pulls in `config` (read once at import).
process.env.ORG_HIERARCHY_ENABLED = 'true';

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { AggregatorStoreFake, _setAggregatorStore } from '../services/aggregator-store/index.js';
import {
  AggregatorOrgStoreFake,
  buildAggregatorOrg,
  _setAggregatorOrgStore,
} from '../services/aggregator-org-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('cleanup-stale — org prune (ORG_HIERARCHY_ENABLED)', () => {
  let app: FastifyInstance;
  let orgStore: AggregatorOrgStoreFake;
  let idp: IdpAdminFake;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';

    _setAggregatorStore(new AggregatorStoreFake());
    orgStore = new AggregatorOrgStoreFake();
    idp = new IdpAdminFake();
    _setAggregatorOrgStore(orgStore);
    _setIdpAdmin(idp);
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
    _setAggregatorOrgStore(null);
    _setIdpAdmin(null);
    _setAccessTokenVerifier(null);
  });

  it('prunes a stale pending org + its KC owner user and mirrored group', async () => {
    // A KC owner user + group the prune should remove.
    const owner = await idp.createUser({
      email: 'stale.owner@x.org',
      username: 'stale.owner@x.org',
      phone: '+911111111111',
      enabled: false,
    });
    if (!owner.ok) throw new Error('seed owner');
    const group = await idp.createGroup('org-stale', { org_id: 'o-stale' });
    if (!group.ok) throw new Error('seed group');

    orgStore.seed([
      buildAggregatorOrg({
        id: 'o-stale',
        slug: 'stale',
        ownerEmail: 'stale.owner@x.org',
        ownerKcSub: owner.value.id,
        kcGroupId: group.value.id,
        status: 'pending',
        // Far past the TTL + grace cutoff.
        updatedAt: new Date('2020-01-01T00:00:00Z'),
      }),
      // A fresh pending org (updated now) that must survive the cutoff.
      buildAggregatorOrg({
        id: 'o-fresh',
        slug: 'fresh',
        ownerEmail: 'fresh@x.org',
        status: 'pending',
        updatedAt: new Date(),
      }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { orgsScanned: number; orgsPruned: number; orgsPrunedIds: string[] };
    expect(body.orgsPruned).toBe(1);
    expect(body.orgsPrunedIds).toEqual(['o-stale']);

    // Stale org gone, fresh one survives.
    const staleRow = await orgStore.findById('o-stale');
    expect(staleRow.ok && staleRow.value).toBeNull();
    const freshRow = await orgStore.findById('o-fresh');
    expect(freshRow.ok && freshRow.value !== null).toBe(true);
    // KC owner user + group removed.
    const ownerLookup = await idp.findByEmail('stale.owner@x.org');
    expect(ownerLookup.ok && ownerLookup.value).toBeNull();
    expect(idp.getGroup(group.value.id)).toBeUndefined();
  });
});
