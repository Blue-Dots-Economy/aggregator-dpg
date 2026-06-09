/**
 * Tests for the admin POST /v1/links/create + PATCH /v1/links/:id handlers'
 * behaviour around the per-link `registration_mode` key:
 *
 *   - create defaults the field to `form` (legacy full-profile default)
 *   - create accepts a declared mode (`voice`) and persists it
 *   - create rejects an undeclared mode with 400 INVALID_REGISTRATION_MODE
 *   - create rejects `voice` (submission_shape=account_only) +
 *     completion_actions[] with 400 INVALID_CONFIG
 *   - PATCH rejects any `registration_mode` in the body (UpdateLinkBodySchema
 *     is .strict(); this pins that as a regression)
 *
 * The blue_dot test fixture declares two modes: `voice` (account_only) and
 * `form` (account_and_profile). Uses a tracking stub for the registration-links
 * store + the in-memory aggregator fake. Auth is stubbed via
 * `_setAccessTokenVerifier`.
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
      completionActions: input.completionActions ?? [],
      registrationMode: input.registrationMode ?? 'form',
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

describe('POST /v1/links/create — registration_mode', () => {
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

  it('defaults registration_mode to "form" when omitted', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().registration_mode).toBe('form');
    expect(store.creates).toHaveLength(1);
    expect(store.creates[0]!.registrationMode).toBe('form');
  });

  it('accepts registration_mode=voice and persists it', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker', registration_mode: 'voice' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().registration_mode).toBe('voice');
    expect(store.creates[0]!.registrationMode).toBe('voice');
  });

  it('rejects an undeclared mode with 400 INVALID_REGISTRATION_MODE', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker', registration_mode: 'kiosk' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_REGISTRATION_MODE');
    expect(store.creates).toHaveLength(0);
  });

  it('rejects a non-snake_case mode value with 400 SCHEMA_VALIDATION', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker', registration_mode: 'Bad-Key' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
  });

  it('rejects voice (account_only) + completion_actions[] with 400 INVALID_CONFIG', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: {
        domain: 'seeker',
        registration_mode: 'voice',
        completion_actions: [
          { channel: 'sms', template_id: 't1', delay_seconds: 0, max_retries: 3 },
        ],
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_CONFIG');
    expect(store.creates).toHaveLength(0);
  });

  it('allows form (account_and_profile) + completion_actions[]', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: {
        domain: 'seeker',
        registration_mode: 'form',
        completion_actions: [
          { channel: 'sms', template_id: 't1', delay_seconds: 0, max_retries: 3 },
        ],
      },
    });
    expect(r.statusCode).toBe(201);
    expect(store.creates[0]!.completionActions).toHaveLength(1);
  });
});

describe('PATCH /v1/links/:id — registration_mode immutability', () => {
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

  it('rejects body containing registration_mode with 400', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/00000000-0000-4000-8000-000000000001',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { registration_mode: 'voice' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
  });
});
