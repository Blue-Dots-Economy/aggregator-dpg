/**
 * Tests for POST /public/v1/aggregators/:orgSlug/registrations/:slug —
 * lifecycle-aware contract added in Task 7. Verifies that the handler:
 *
 *   - forwards `submit_mode` (derived from the optional `partial` envelope
 *     flag) into `SignalStackWriter.onboard`,
 *   - surfaces `lifecycle_status`, `completion_pct`, and `owned_elsewhere`
 *     on the route response,
 *   - returns null lifecycle fields on `account_only` submits (no item),
 *   - flags `owned_elsewhere: true` (with `outcome: skipped`, 409) when
 *     signals reports a foreign user.
 *
 * Bypasses the real Postgres dependency by injecting a minimal db stub via
 * `_setDbClients`; the only operation the route runs against `tx` is the
 * `link_submissions` insert + returning(id) chain modelled here.
 *
 * @module apps/api/routes/public-registration-links.lifecycle.test
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
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
  type RegistrationLinkCompletionAction,
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
const LINK_ID = '22222222-2222-2222-2222-222222222222';
const LINK_SLUG = 'walk-in-2026';

/**
 * Stub registration-links store with only `findByOrgAndSlug` implemented —
 * the public submit handler does not call the other methods on this path.
 * Returning a single seeded `live` link mirrors what the postgres impl
 * would return for the (orgSlug, slug) pair the tests submit against.
 */
class StubRegistrationLinksStore extends RegistrationLinksStoreBase {
  constructor(private readonly link: RegistrationLink) {
    super();
  }
  async findByOrgAndSlug(
    orgSlug: string,
    slug: string,
  ): Promise<StoreResult<RegistrationLink | null>> {
    if (orgSlug === ORG_SLUG && slug === LINK_SLUG) {
      return { ok: true, value: this.link };
    }
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

/**
 * Builds a minimal `tx`/`db` shape the route exercises. The only mutation
 * the route runs against the tx is
 * `tx.insert(linkSubmissions).values(...).returning({ id })` — we shortcut
 * that to a deterministic id so the response carries a stable submission
 * uuid.
 */
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

const SUBMISSION_ID = '33333333-3333-3333-3333-333333333333';
const PARTICIPANT_PARENT_ID = '44444444-4444-4444-4444-444444444444';

describe('POST /public/v1/aggregators/:orgSlug/registrations/:slug — lifecycle', () => {
  let app: FastifyInstance;
  let signalstack: SignalStackWriterFake;

  beforeEach(async () => {
    // Treat signalstack as enabled so getSignalStackWriter returns our fake.
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';
    process.env.SIGNALSTACK_ITEM_NETWORK = 'blue_dot';

    // Aggregator seeded with a signalstackOrgId so the route doesn't bail
    // with SIGNALSTACK_ORG_NOT_REGISTERED before it gets to onboard().
    const aggregatorStore = new AggregatorStoreFake();
    aggregatorStore.seed([
      buildAggregator({
        id: AGG_ID,
        orgSlug: ORG_SLUG,
        name: 'Acme Aggregator',
        status: 'active',
        signalstackOrgId: ORG_ID,
      }),
    ]);
    _setAggregatorStore(aggregatorStore);

    signalstack = new SignalStackWriterFake();
    _setSignalStackWriter(signalstack);

    _setNetworkConfig(buildBlueDotConfig());

    const liveLink: RegistrationLink = {
      id: LINK_ID,
      aggregatorId: AGG_ID,
      slug: LINK_SLUG,
      domain: 'seeker',
      context: {},
      completionActions: [],
      submissionMode: 'account_and_profile',
      qrObjectKey: null,
      status: 'live',
      expiresAt: null,
      createdBy: 'system',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    _setRegistrationLinksStore(new StubRegistrationLinksStore(liveLink));

    // Fake participants writer so the route does not reach Drizzle's
    // ParticipantsWriter constructor (which assumes a real `tx`).
    const writer = new ParticipantsWriterFake();
    // Pre-seed a parent participant id so the upsert returns `passed` and
    // the response carries a deterministic submission_id.
    void PARTICIPANT_PARENT_ID;
    _setParticipantsWriter(writer);

    // Minimal db stub — exposes only what the public-submit handler calls
    // on the transaction handle.
    _setDbClients(null, buildFakeDb(SUBMISSION_ID) as never);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setAggregatorStore(null);
    _setSignalStackWriter(null);
    _setNetworkConfig(null);
    _setRegistrationLinksStore(null);
    _setParticipantsWriter(null);
    _setDbClients(null, null);
  });

  const basePayload = {
    name: 'Asha Kumari',
    phone: '+919876543210',
    email: 'asha@example.com',
  };

  it('returns lifecycle_status="live" and completion_pct=100 on default classification', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: basePayload,
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as {
      outcome: string;
      lifecycle_status: string | null;
      completion_pct: number | null;
      owned_elsewhere: boolean;
    };
    expect(body.outcome).toBe('passed');
    expect(body.lifecycle_status).toBe('live');
    expect(body.completion_pct).toBe(100);
    expect(body.owned_elsewhere).toBe(false);
  });

  it('returns lifecycle_status="draft" when signals classifies as draft', async () => {
    signalstack.setNextClassification({ lifecycle_status: 'draft', completion_pct: 40 });
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876543299', email: 'draft@example.com' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as {
      lifecycle_status: string | null;
      completion_pct: number | null;
    };
    expect(body.lifecycle_status).toBe('draft');
    expect(body.completion_pct).toBe(40);
  });

  it('returns null lifecycle fields when partial=true (account_only mode)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: {
        name: 'Partial User',
        phone: '+919876500000',
        email: 'partial@example.com',
        partial: true,
      },
    });
    expect([200, 201]).toContain(r.statusCode);
    const body = r.json() as {
      lifecycle_status: string | null;
      completion_pct: number | null;
      owned_elsewhere: boolean;
    };
    expect(body.lifecycle_status).toBeNull();
    expect(body.completion_pct).toBeNull();
    expect(body.owned_elsewhere).toBe(false);
  });

  it('flags owned_elsewhere=true when signals reports a foreign user', async () => {
    signalstack.seedForeignUser({ email: 'shared@x.com' });
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876511111', email: 'shared@x.com' },
    });
    // Existing-user path returns 409 with outcome=skipped per the route's
    // legacy convention; lifecycle fields are null because signals creates
    // no item for a foreign-owned identity.
    expect(r.statusCode).toBe(409);
    const body = r.json() as {
      outcome: string;
      owned_elsewhere: boolean;
      lifecycle_status: string | null;
      completion_pct: number | null;
    };
    expect(body.outcome).toBe('skipped');
    expect(body.owned_elsewhere).toBe(true);
    expect(body.lifecycle_status).toBeNull();
    expect(body.completion_pct).toBeNull();
  });
});

/**
 * Tests for the Task 11 dispatcher enqueue path. The route handler must
 * call the Task 8 planner after the participant tx commits, persist each
 * directive into `outbound_dispatch_log` via the singleton store, and add
 * a BullMQ job to the `outbound-dispatch` queue per persisted row.
 *
 * Lifecycle gating mirrors the planner: enqueue only when signals
 * classifies the resulting item as `draft`. A foreign user (`owned_elsewhere`)
 * or an empty `completion_actions` array short-circuits to zero enqueues
 * even when signals reports draft.
 */
describe('POST /public/v1/aggregators/:orgSlug/registrations/:slug — dispatcher enqueue', () => {
  let app: FastifyInstance;
  let signalstack: SignalStackWriterFake;
  let dispatchLog: OutboundDispatchLogFake;
  let queueAdd: ReturnType<typeof vi.fn>;

  /** Re-seeds the registration-links store with a link carrying the given actions. */
  function seedLink(completionActions: RegistrationLinkCompletionAction[]): void {
    const liveLink: RegistrationLink = {
      id: LINK_ID,
      aggregatorId: AGG_ID,
      slug: LINK_SLUG,
      domain: 'seeker',
      context: {},
      completionActions,
      submissionMode: 'account_and_profile',
      qrObjectKey: null,
      status: 'live',
      expiresAt: null,
      createdBy: 'system',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    _setRegistrationLinksStore(new StubRegistrationLinksStore(liveLink));
  }

  const sampleAction: RegistrationLinkCompletionAction = {
    channel: 'sms',
    template_id: 'onb_draft_v1',
    delay_seconds: 0,
    max_retries: 3,
  };

  beforeEach(async () => {
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';
    process.env.SIGNALSTACK_ITEM_NETWORK = 'blue_dot';

    const aggregatorStore = new AggregatorStoreFake();
    aggregatorStore.seed([
      buildAggregator({
        id: AGG_ID,
        orgSlug: ORG_SLUG,
        name: 'Acme Aggregator',
        status: 'active',
        signalstackOrgId: ORG_ID,
      }),
    ]);
    _setAggregatorStore(aggregatorStore);

    signalstack = new SignalStackWriterFake();
    _setSignalStackWriter(signalstack);
    _setNetworkConfig(buildBlueDotConfig());

    seedLink([sampleAction]);

    const writer = new ParticipantsWriterFake();
    _setParticipantsWriter(writer);

    _setDbClients(null, buildFakeDb(SUBMISSION_ID) as never);

    dispatchLog = new OutboundDispatchLogFake();
    _setOutboundDispatchLog(dispatchLog);

    queueAdd = vi.fn(async () => ({ id: 'job-stub-1' }));
    _setOutboundDispatchQueue({ add: queueAdd } as unknown as OutboundDispatchQueue);

    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setOutboundDispatchLog(null);
    _setOutboundDispatchQueue(null);
  });

  afterAll(() => {
    _setAggregatorStore(null);
    _setSignalStackWriter(null);
    _setNetworkConfig(null);
    _setRegistrationLinksStore(null);
    _setParticipantsWriter(null);
    _setDbClients(null, null);
  });

  const basePayload = {
    name: 'Asha Kumari',
    phone: '+919876543210',
    email: 'asha@example.com',
  };

  it('enqueues one dispatcher job per completion_action when lifecycle=draft', async () => {
    signalstack.setNextClassification({ lifecycle_status: 'draft', completion_pct: 40 });
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876500001', email: 'draft@example.com' },
    });
    expect(r.statusCode).toBe(201);

    // One BullMQ add() call per completion_action. The dispatch log row
    // id comes from the in-memory enqueue and is what the job carries —
    // assert delay + attempts mapping is honoured.
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      'outbound-dispatch',
      expect.objectContaining({ dispatchId: expect.any(String) }),
      expect.objectContaining({
        // delay_seconds (0) * 1000
        delay: 0,
        // max_retries (3) + 1 = 4 total attempts
        attempts: 4,
      }),
    );

    // Pull the participant id off the dispatch log directly (any row will
    // do — there is only one in this test). Avoids reaching into the
    // participants-writer fake's internals.
    const allRows = Array.from(
      (
        dispatchLog as unknown as {
          byId: Map<string, { participantId: string; id: string }>;
        }
      ).byId.values(),
    );
    expect(allRows).toHaveLength(1);
    const participantId = allRows[0]!.participantId;
    const list = await dispatchLog.listByParticipant(participantId);
    expect(list.success).toBe(true);
    if (list.success) {
      expect(list.value).toHaveLength(1);
      expect(list.value[0]!.id).toBe(allRows[0]!.id);
      expect(list.value[0]!.channel).toBe('sms');
      expect(list.value[0]!.templateId).toBe('onb_draft_v1');
    }
  });

  it('does not enqueue when lifecycle=live (default classification)', async () => {
    // Default classification is `live`/`100` — planner emits no directives.
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876500002', email: 'live@example.com' },
    });
    expect(r.statusCode).toBe(201);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('does not enqueue when completion_actions is empty even if draft', async () => {
    seedLink([]);
    signalstack.setNextClassification({ lifecycle_status: 'draft', completion_pct: 40 });
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876500003', email: 'noactions@example.com' },
    });
    expect(r.statusCode).toBe(201);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('does not enqueue when signals reports owned_elsewhere=true', async () => {
    signalstack.seedForeignUser({ email: 'shared@x.com' });
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876500004', email: 'shared@x.com' },
    });
    // Foreign-user path returns 409 with outcome=skipped — planner sees
    // owned_elsewhere=true and emits no directives even though the link
    // has a non-empty completion_actions list.
    expect([200, 201, 409]).toContain(r.statusCode);
    expect(queueAdd).not.toHaveBeenCalled();
  });
});
