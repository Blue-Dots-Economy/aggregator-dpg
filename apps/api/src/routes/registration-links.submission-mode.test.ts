/**
 * Tests for the admin POST /v1/links/create + PATCH /v1/links/:id handlers'
 * behaviour around the per-link `submission_mode` toggle:
 *
 *   - create defaults the field to `'account_and_profile'`
 *   - create accepts `'account_only'` and persists it
 *   - create rejects unknown enum values with 400
 *   - PATCH rejects any `submission_mode` in the body (already covered by
 *     UpdateLinkBodySchema.strict(), this test pins that as a regression)
 *
 * Uses a tracking stub for the registration-links store + the in-memory
 * aggregator fake. Auth is stubbed via `_setAccessTokenVerifier`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import {
  AggregatorStoreFake,
  _setAggregatorStore,
  buildAggregator,
} from '../services/aggregator-store/index.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import {
  _setRegistrationLinksStore,
  RegistrationLinksStoreBase,
  type RegistrationLink,
  type CreateRegistrationLinkInput,
  type StoreResult,
} from '../services/registration-links-store/index.js';
import { _setDbClients } from '../db/client.js';

const AGG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = 'org-signalstack-1';
const ORG_SLUG = 'acme';
const USER_ID = 'kc-user-1';

/**
 * Tracking stub: records every create input and returns a synthetic row.
 * Status forced to 'draft' to keep the route off the QR/S3 path.
 */
class TrackingRegistrationLinksStore extends RegistrationLinksStoreBase {
  readonly creates: CreateRegistrationLinkInput[] = [];
  private idCounter = 0;

  async create(input: CreateRegistrationLinkInput): Promise<StoreResult<RegistrationLink>> {
    this.creates.push(input);
    this.idCounter++;
    const now = new Date();
    const row: RegistrationLink = {
      id: `link-${this.idCounter}`,
      aggregatorId: input.aggregatorId,
      slug: input.slug,
      domain: input.domain,
      context: input.context,
      submissionMode: input.submissionMode ?? 'account_and_profile',
      qrObjectKey: null,
      status: input.status ?? 'draft',
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    return { ok: true, value: row };
  }

  async findById(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async findBySlug(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async findByOrgAndSlug(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async updateQrKey(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
  async updateDraft(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
  async list(): Promise<StoreResult<{ rows: RegistrationLink[]; total: number }>> {
    return { ok: true, value: { rows: [], total: 0 } };
  }
  async updateStatus(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
}

const AUTH_TOKEN = 'agg-a-token';

/**
 * Minimal db stub that satisfies fetchLinkMetrics' query chain by resolving
 * to an empty rowset. The route then falls back to ZERO_METRICS — exactly
 * what we want since this test file does not exercise the metrics path.
 */
function buildMetricsStubDb(): unknown {
  const emptyChain = {
    select: () => emptyChain,
    from: () => emptyChain,
    where: () => emptyChain,
    groupBy: () => Promise.resolve([] as unknown[]),
  };
  return emptyChain;
}

async function bootApp(): Promise<{ app: FastifyInstance; store: TrackingRegistrationLinksStore }> {
  _resetJwks();
  process.env.KEYCLOAK_URL = 'http://kc.local';
  process.env.KEYCLOAK_REALM = 'aggregator';
  _setNetworkConfig(buildBlueDotConfig());
  _setAccessTokenVerifier(async (token) => {
    if (token !== AUTH_TOKEN) throw new Error('invalid');
    return {
      sub: USER_ID,
      email: 'a@x.com',
      aggregator_id: AGG_ID,
      aggregator_type: 'seeker',
      decision_made: 'approved',
    };
  });
  const aggStore = new AggregatorStoreFake();
  aggStore.seed([
    buildAggregator({
      id: AGG_ID,
      orgSlug: ORG_SLUG,
      name: 'Acme',
      status: 'active',
      signalstackOrgId: ORG_ID,
    }),
  ]);
  _setAggregatorStore(aggStore);
  const store = new TrackingRegistrationLinksStore();
  _setRegistrationLinksStore(store);
  _setDbClients(null, buildMetricsStubDb() as never);
  const app = await buildApp();
  return { app, store };
}

describe('POST /v1/links/create — submission_mode', () => {
  let app: FastifyInstance;
  let store: TrackingRegistrationLinksStore;

  beforeEach(async () => {
    ({ app, store } = await bootApp());
  });
  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setAggregatorStore(null);
    _setRegistrationLinksStore(null);
    _setNetworkConfig(null);
    _setDbClients(null, null);
  });

  it('defaults submission_mode to account_and_profile when omitted', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().submission_mode).toBe('account_and_profile');
    expect(store.creates).toHaveLength(1);
    expect(store.creates[0]!.submissionMode).toBe('account_and_profile');
  });

  it('accepts submission_mode=account_only and persists it', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker', submission_mode: 'account_only' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().submission_mode).toBe('account_only');
    expect(store.creates[0]!.submissionMode).toBe('account_only');
  });

  it('rejects unknown submission_mode values with 400', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker', submission_mode: 'bogus' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
  });
});

describe('PATCH /v1/links/:id — submission_mode immutability', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await bootApp());
  });
  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setAggregatorStore(null);
    _setRegistrationLinksStore(null);
    _setNetworkConfig(null);
    _setDbClients(null, null);
  });

  it('rejects body containing submission_mode with 400', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/00000000-0000-4000-8000-000000000001',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { submission_mode: 'account_only' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
  });
});
