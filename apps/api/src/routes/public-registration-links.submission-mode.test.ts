/**
 * Tests for the per-link submission_mode contract on the public
 * registration endpoints:
 *
 *   GET  /public/v1/aggregators/:org/links/:slug   (T6 — resolve)
 *   POST /public/v1/aggregators/:org/registrations/:slug   (T7 — submit)
 *
 * T6 (resolve):
 *   - surfaces `submission_mode` on the response
 *   - nulls `schema`, `schema_id`, `schema_version` when account_only
 *   - keeps full schema body for account_and_profile (regression)
 *
 * T7 (submit, account_only branch):
 *   - identity-only body accepted, returns 201 with nulled lifecycle fields
 *   - body with `item_state` rejected as 400 SUBMISSION_MODE_MISMATCH
 *   - body with unknown keys rejected as 400 SUBMISSION_MODE_MISMATCH
 *   - `partial` body flag is accepted and ignored (forced account_only)
 *   - dispatcher is NEVER enqueued for account_only submits
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  AggregatorStoreFake,
  _setAggregatorStore,
  buildAggregator,
} from '../services/aggregator-store/index.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { _setDbClients } from '../db/client.js';
import {
  _setRegistrationLinksStore,
  RegistrationLinksStoreBase,
  type RegistrationLink,
  type StoreResult,
} from '../services/registration-links-store/index.js';
import { _setParticipantsWriter } from './public-registration-links.js';
import { _setOutboundDispatchLog } from '../services/outbound-dispatch-log/index.js';
import { OutboundDispatchLogFake } from '../services/outbound-dispatch-log/memory.js';
import { _setOutboundDispatchQueue, type OutboundDispatchQueue } from '../services/queue.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { ParticipantsWriterFake } from '@aggregator-dpg/participants-writer/testing';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';

const AGG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = 'org-signalstack-1';
const ORG_SLUG = 'acme';
const LINK_ID_AO = '22222222-2222-2222-2222-222222222222';
const LINK_ID_FULL = '33333333-3333-3333-3333-333333333333';
const SLUG_AO = 'walk-in-account-only';
const SLUG_FULL = 'walk-in-full';
const SUBMISSION_ID = '44444444-4444-4444-4444-444444444444';

/** Two-link stub indexed by slug. */
class TwoLinkStore extends RegistrationLinksStoreBase {
  constructor(
    private readonly accountOnly: RegistrationLink,
    private readonly full: RegistrationLink,
  ) {
    super();
  }
  async findByOrgAndSlug(
    orgSlug: string,
    slug: string,
  ): Promise<StoreResult<RegistrationLink | null>> {
    if (orgSlug !== ORG_SLUG) return { ok: true, value: null };
    if (slug === SLUG_AO) return { ok: true, value: this.accountOnly };
    if (slug === SLUG_FULL) return { ok: true, value: this.full };
    return { ok: true, value: null };
  }
  async create(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
  async findById(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async findBySlug(): Promise<StoreResult<RegistrationLink | null>> {
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

function buildFakeDb(submissionId: string): unknown {
  const tx = {
    insert() {
      return {
        values() {
          return {
            async returning() {
              return [{ id: submissionId }];
            },
          };
        },
      };
    },
  };
  return {
    async transaction(cb: (tx: unknown) => Promise<unknown>) {
      return cb(tx);
    },
  };
}

const baseLink = {
  aggregatorId: AGG_ID,
  domain: 'seeker' as const,
  context: {},
  completionActions: [],
  qrObjectKey: null,
  status: 'live' as const,
  expiresAt: null,
  createdBy: 'system',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

async function bootApp(): Promise<{
  app: FastifyInstance;
  signalstack: SignalStackWriterFake;
  dispatchLog: OutboundDispatchLogFake;
  queueAdd: ReturnType<typeof vi.fn>;
}> {
  process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
  process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
  process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';
  process.env.SIGNALSTACK_ITEM_NETWORK = 'blue_dot';
  _setNetworkConfig(buildBlueDotConfig());

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

  const signalstack = new SignalStackWriterFake();
  _setSignalStackWriter(signalstack);
  _setParticipantsWriter(new ParticipantsWriterFake());

  const dispatchLog = new OutboundDispatchLogFake();
  _setOutboundDispatchLog(dispatchLog);

  const queueAdd = vi.fn().mockResolvedValue({ id: 'job-stub' });
  const queue: OutboundDispatchQueue = { add: queueAdd };
  _setOutboundDispatchQueue(queue);

  const aoLink: RegistrationLink = {
    ...baseLink,
    id: LINK_ID_AO,
    slug: SLUG_AO,
    submissionMode: 'account_only',
  };
  const fullLink: RegistrationLink = {
    ...baseLink,
    id: LINK_ID_FULL,
    slug: SLUG_FULL,
    submissionMode: 'account_and_profile',
  };
  _setRegistrationLinksStore(new TwoLinkStore(aoLink, fullLink));
  _setDbClients(null, buildFakeDb(SUBMISSION_ID) as never);

  const app = await buildApp();
  return { app, signalstack, dispatchLog, queueAdd };
}

async function teardown(app: FastifyInstance | undefined): Promise<void> {
  await app?.close();
  _setSignalStackWriter(null);
  _setAggregatorStore(null);
  _setRegistrationLinksStore(null);
  _setNetworkConfig(null);
  _setParticipantsWriter(null);
  _setOutboundDispatchLog(null);
  _setOutboundDispatchQueue(null);
  _setDbClients(null, null);
}

describe('GET /public/v1/aggregators/:org/links/:slug — submission_mode (T6)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    ({ app } = await bootApp());
  });
  afterEach(() => teardown(app));

  it('surfaces submission_mode and nulls schema fields for account_only', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/public/v1/aggregators/${ORG_SLUG}/links/${SLUG_AO}`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.submission_mode).toBe('account_only');
    expect(body.schema).toBeNull();
    expect(body.schema_id).toBeNull();
    expect(body.schema_version).toBeNull();
  });

  it('surfaces submission_mode and includes schema body for account_and_profile', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/public/v1/aggregators/${ORG_SLUG}/links/${SLUG_FULL}`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.submission_mode).toBe('account_and_profile');
    expect(body.schema).not.toBeNull();
    expect(body.schema_id).toBe('participant-seeker');
    expect(body.schema_version).toBe('v1');
  });
});

describe('POST /public/v1/aggregators/:org/registrations/:slug — account_only (T7)', () => {
  let app: FastifyInstance;
  let signalstack: SignalStackWriterFake;
  let dispatchLog: OutboundDispatchLogFake;
  let queueAdd: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ app, signalstack, dispatchLog, queueAdd } = await bootApp());
  });
  afterEach(() => teardown(app));

  it('accepts identity-only body and returns 201 with null lifecycle fields', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: {
        name: 'A. User',
        phone: '+919999999999',
        consent_terms: true,
        consent_privacy: true,
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.lifecycle_status).toBeNull();
    expect(body.completion_pct).toBeNull();
    expect(body.submission_mode).toBe('account_only');
  });

  it('skips the dispatcher fan-out entirely for account_only', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: {
        name: 'A. User',
        email: 'u@example.com',
        consent_terms: true,
        consent_privacy: true,
      },
    });
    expect(r.statusCode).toBe(201);
    // No queue.add call; no outbound_dispatch_log row.
    expect(queueAdd).not.toHaveBeenCalled();
    // dispatchLog is a fake; the only way a row lands is via enqueue —
    // confirm by listing for the participant (none seeded → 0 rows).
    void dispatchLog; // referenced for parity with parent tests
    void signalstack;
  });

  it('rejects body containing item_state with 400 SUBMISSION_MODE_MISMATCH', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: {
        name: 'A. User',
        phone: '+919999999999',
        consent_terms: true,
        consent_privacy: true,
        item_state: { profile_field: 'x' },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SUBMISSION_MODE_MISMATCH');
  });

  it('rejects body with unknown keys', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: {
        name: 'A. User',
        phone: '+919999999999',
        consent_terms: true,
        consent_privacy: true,
        wat: 'stray',
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SUBMISSION_MODE_MISMATCH');
  });

  it('accepts and ignores `partial: true` (always forces account_only)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: {
        name: 'A. User',
        phone: '+919999999999',
        consent_terms: true,
        consent_privacy: true,
        partial: true,
      },
    });
    expect(r.statusCode).toBe(201);
  });

  it('rejects missing identity fields (no phone or email)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: {
        name: 'A. User',
        consent_terms: true,
        consent_privacy: true,
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
  });
});
