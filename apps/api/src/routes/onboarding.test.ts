/**
 * Tests for the onboarding metrics endpoints
 * (`GET /v1/onboarding/summary`, `GET /v1/onboarding/by-source`).
 *
 * Both routes are thin aggregation reads over the `onboarding` rollup table,
 * scoped to the caller's `user_id` and optionally date-bounded by
 * `?from=&to=`. Covers the auth wrapper, the date-range query validation,
 * and both aggregation shapes.
 *
 * @module apps/api/routes/onboarding.test
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { PgDialect } from 'drizzle-orm/pg-core';
import { is, SQL } from 'drizzle-orm';
import { ACTING_ACCOUNT_HEADER } from '@aggregator-dpg/shared-primitives/user-org';
import { getIdentityStore } from '../services/identity-store/index.js';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../services/user-store/index.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  _setOrganisationStore,
} from '../services/organisation-store/index.js';

interface SummaryRow {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

interface BySourceRow extends SummaryRow {
  source: string;
}

let summaryRows: SummaryRow[] = [];
let bySourceRows: BySourceRow[] = [];
let lastWhereCondition: unknown;

vi.mock('../db/client.js', () => ({
  getDb: () => ({
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (cond: unknown) => {
          lastWhereCondition = cond;
          return {
            then(onFulfilled: (v: SummaryRow[]) => unknown, onRejected?: (e: unknown) => unknown) {
              return Promise.resolve(summaryRows).then(onFulfilled, onRejected);
            },
            groupBy(_col: unknown) {
              return Promise.resolve(bySourceRows);
            },
          };
        },
      }),
    }),
  }),
}));

const AGG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('onboarding routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';

    summaryRows = [];
    bySourceRows = [];
    lastWhereCondition = undefined;

    _setAccessTokenVerifier(async (token) => {
      if (token === 'approved') {
        return { sub: 'kc-1', user_id: AGG_A, decision_made: 'approved' };
      }
      if (token === 'pending') {
        return { sub: 'kc-1', user_id: AGG_A, decision_made: 'pending' };
      }
      if (token === 'serves-both') {
        return {
          sub: 'kc-1',
          user_id: AGG_A,
          decision_made: 'approved',
          aggregator_type: ['seeker', 'provider'],
        };
      }
      if (token === 'serves-seeker') {
        return {
          sub: 'kc-1',
          user_id: AGG_A,
          decision_made: 'approved',
          aggregator_type: ['seeker'],
        };
      }
      if (token === 'owner') {
        return { sub: 'kc-owner', email: 'owner@example.org' };
      }
      if (token === 'no-agg-id') {
        return { sub: 'kc-2', decision_made: 'approved' };
      }
      throw new Error('invalid token');
    });

    _setNetworkConfig(buildBlueDotConfig());
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setUserStore(null);
    _setOrganisationStore(null);
    _setAccessTokenVerifier(null);
    _setNetworkConfig(null);
  });

  const AUTH = (token: string) => ({ authorization: `Bearer ${token}` });

  describe('GET /v1/onboarding/summary', () => {
    it('401s without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/onboarding/summary' });
      expect(res.statusCode).toBe(401);
    });

    it('401s when the token has no user_id claim', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary',
        headers: AUTH('no-agg-id'),
      });
      expect(res.statusCode).toBe(401);
    });

    it('403 NOT_APPROVED when decision_made is pending', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary',
        headers: AUTH('pending'),
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_APPROVED');
    });

    it('400 SCHEMA_VALIDATION on a malformed `from` date', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary?from=not-a-date',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
    });

    it('400 SCHEMA_VALIDATION on a malformed `to` date', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary?to=2026-13-99',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(400);
    });

    it('200s with zeroed counters when there are no rows', async () => {
      summaryRows = [];
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        user_id: AGG_A,
        from: null,
        to: null,
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
      });
    });

    it('200s with the summed counters from the store', async () => {
      summaryRows = [{ total: 42, passed: 30, failed: 10, skipped: 2 }];
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.total).toBe(42);
      expect(body.passed).toBe(30);
      expect(body.failed).toBe(10);
      expect(body.skipped).toBe(2);
    });

    it('echoes back the resolved from/to ISO bounds when supplied', async () => {
      summaryRows = [{ total: 1, passed: 1, failed: 0, skipped: 0 }];
      const from = '2026-01-01T00:00:00.000Z';
      const to = '2026-02-01T00:00:00.000Z';
      const res = await app.inject({
        method: 'GET',
        url: `/v1/onboarding/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { from: string; to: string };
      expect(body.from).toBe(from);
      expect(body.to).toBe(to);
      expect(lastWhereCondition).toBeDefined();
    });
  });

  describe('GET /v1/onboarding/by-source', () => {
    it('401s without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/onboarding/by-source' });
      expect(res.statusCode).toBe(401);
    });

    it('401s when the token has no user_id claim', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/by-source',
        headers: AUTH('no-agg-id'),
      });
      expect(res.statusCode).toBe(401);
    });

    it('403 NOT_APPROVED when decision_made is pending', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/by-source',
        headers: AUTH('pending'),
      });
      expect(res.statusCode).toBe(403);
    });

    it('400 SCHEMA_VALIDATION on a malformed date range', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/by-source?from=nope',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(400);
    });

    it('200s with an empty by_source array when there are no rows', async () => {
      bySourceRows = [];
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/by-source',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { by_source: unknown[] };
      expect(body.by_source).toEqual([]);
    });

    it('200s with the per-source breakdown', async () => {
      bySourceRows = [
        { source: 'bulk', total: 10, passed: 8, failed: 2, skipped: 0 },
        { source: 'link', total: 5, passed: 5, failed: 0, skipped: 0 },
      ];
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/by-source',
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        user_id: string;
        by_source: Array<{ source: string; total: number }>;
      };
      expect(body.user_id).toBe(AGG_A);
      expect(body.by_source).toHaveLength(2);
      expect(body.by_source.find((r) => r.source === 'bulk')?.total).toBe(10);
      expect(body.by_source.find((r) => r.source === 'link')?.total).toBe(5);
    });

    it('applies the from/to bounds echoed in the response', async () => {
      bySourceRows = [{ source: 'bulk', total: 1, passed: 1, failed: 0, skipped: 0 }];
      const from = '2026-01-01T00:00:00.000Z';
      const res = await app.inject({
        method: 'GET',
        url: `/v1/onboarding/by-source?from=${encodeURIComponent(from)}`,
        headers: AUTH('approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { from: string; to: string | null };
      expect(body.from).toBe(from);
      expect(body.to).toBeNull();
    });
  });

  describe('?domain= profile type filter', () => {
    /** The where clause of the last query, rendered as Postgres SQL. */
    const lastWhereSql = (): { sql: string; params: unknown[] } => {
      if (!is(lastWhereCondition, SQL)) throw new Error('no query ran');
      return new PgDialect().sqlToQuery(lastWhereCondition);
    };

    for (const path of ['/v1/onboarding/summary', '/v1/onboarding/by-source']) {
      it(`${path} counts only the requested type's uploads and links`, async () => {
        const res = await app.inject({
          method: 'GET',
          url: `${path}?domain=provider`,
          headers: AUTH('serves-both'),
        });
        expect(res.statusCode).toBe(200);
        const where = lastWhereSql();
        expect(where.sql).toContain('"bulk_uploads"."participant_type" = $');
        expect(where.sql).toContain('"registration_links"."domain" = $');
        expect(where.params).toContain('provider');
      });

      it(`${path} counts every type when no domain is given`, async () => {
        const res = await app.inject({ method: 'GET', url: path, headers: AUTH('serves-both') });
        expect(res.statusCode).toBe(200);
        expect(lastWhereSql().sql).not.toContain('bulk_uploads');
      });
    }

    it('does not filter when the coordinator serves only the requested type', async () => {
      summaryRows = [{ total: 4, passed: 3, failed: 1, skipped: 0 }];
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary?domain=seeker',
        headers: AUTH('serves-seeker'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ total: 4, passed: 3 });
      expect(lastWhereSql().sql).not.toContain('bulk_uploads');
    });

    it('403 DOMAIN_NOT_SERVED for a type the coordinator does not serve', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/by-source?domain=provider',
        headers: AUTH('serves-seeker'),
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe('DOMAIN_NOT_SERVED');
      expect(lastWhereCondition).toBeUndefined();
    });

    it('400 SCHEMA_VALIDATION for a domain the network does not have', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary?domain=astronaut',
        headers: AUTH('serves-both'),
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
    });
  });

  describe("acting as the owner's own coordinator account", () => {
    const ADMIN = 'adadadad-adad-4ada-8ada-adadadadadad';
    const OWN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    beforeEach(async () => {
      const users = new UserStoreFake();
      users.seed([
        buildCoordinator({ id: OWN, status: 'active', parentOrgId: ORG, signalstackOrgId: 'o1' }),
        // A second coordinator in the same org, whose counts must not be read.
        buildCoordinator({ id: AGG_A, status: 'active', parentOrgId: ORG, signalstackOrgId: 'o2' }),
      ]);
      _setUserStore(users);
      const orgs = new OrganisationStoreFake();
      orgs.seed([buildOrganisation({ id: ORG, status: 'active', ownerUserId: ADMIN })]);
      _setOrganisationStore(orgs);
      const identities = getIdentityStore();
      await identities.link(ADMIN, 'keycloak', 'kc-owner', 'admin');
      await identities.link(OWN, 'keycloak', 'kc-owner', 'coordinator');
      await identities.link(AGG_A, 'keycloak', 'kc-1', 'coordinator');
    });

    it('GET /v1/onboarding/summary counts only the acting coordinator', async () => {
      summaryRows = [{ total: 5, passed: 4, failed: 1, skipped: 0 }];
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary',
        headers: { ...AUTH('owner'), [ACTING_ACCOUNT_HEADER]: OWN },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ user_id: OWN, total: 5 });
      if (!is(lastWhereCondition, SQL)) throw new Error('no query ran');
      const where = new PgDialect().sqlToQuery(lastWhereCondition);
      expect(where.params).toContain(OWN);
      expect(where.params).not.toContain(AGG_A);
    });

    it('403 ACTING_ACCOUNT_INVALID for the other coordinator of the org', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding/summary',
        headers: { ...AUTH('owner'), [ACTING_ACCOUNT_HEADER]: AGG_A },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        error: { code: 'ACTING_ACCOUNT_INVALID', detail: 'acting account not usable' },
      });
      expect(lastWhereCondition).toBeUndefined();
    });
  });
});
