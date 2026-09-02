/**
 * Property test: no participant PII value can reach `campaign_pii_audit`
 * (aggregator-dpg#617).
 *
 * Scope note (deviates from the task-7 brief, which describes seeding "the
 * Signals fake so decrypted participants carry the PII values" and running a
 * "full export submit + poll cycle"): that decrypt step does not exist on the
 * API side at all. `apps/api` never resolves an item id to a participant
 * record or decrypts a contact field — `campaign-export.ts`'s own module doc
 * says so explicitly ("The decrypt → CSV → S3 → email-link work runs in
 * `apps/worker`"). The API only ever sees `item_ids` (uuids), a free-form
 * `metadata` list, and an opaque `content` object; `RequestedAuditInput` and
 * `DumpAuditInput` are built from those plus the verified auth context and
 * deployment config — never from a participant record, because the API never
 * has one. So there is no Signals fake to seed here, and a "poll cycle" adds
 * nothing: `GET /v1/campaign/export/:id` (see `submit-job.audit.test.ts`'s
 * "does not write an audit row for a status poll") writes no row at all.
 *
 * What IS a genuine risk at this layer: `submitCampaignJob` (the code shared
 * by all three org-scoped channels) reads exactly two request-supplied
 * values into the `requested` row — `itemCount` (a count, not a value) and
 * `purpose` (a metadata value, deliberately plumbed through). Everything else
 * on the row is either fixed deployment config (`piiFields`) or derived from
 * the verified token (`actorUserId`/`actorOrgId`/`actorAzp`). The realistic
 * regression this test catches is a future change that widens that surface —
 * e.g. spreading `content` or the full `metadata` array into the audit input
 * instead of just the field names/counts/purpose it's contracted to carry.
 * This test drives PII through every value the request body can carry
 * (`content` fields AND a non-`purpose` metadata key that today's code never
 * reads) and asserts none of it appears in the serialised rows — it would
 * fail the moment such a change landed. It also covers the dump route's
 * `DumpAuditInput`, which carries no caller-supplied value at all (a GET with
 * no body), so its assertion is structural: `details` may only hold the
 * fixed, non-PII shape `{ files, bytes }` (see `DumpAuditInput.details`).
 *
 * Fix-round-1 additions (review of the first version of this file found the
 * guarantee false for voice): a voice-channel case drives PII through
 * `content.variables`, the one channel-specific input that WAS spread
 * verbatim into `piiFields` before `../audit-field-names.ts` existed — see
 * that module's doc for the underlying defect and fix. All PII assertions
 * are now case-insensitive (`content.name.toLowerCase()` would otherwise
 * slip past a case-sensitive `.not.toContain`). Substring matching has an
 * inherent blind spot this file does NOT chase: a truncated or otherwise
 * transformed copy of a PII value (e.g. `content.name.slice(0, 6)`) will not
 * be caught by any string-containment check, case-insensitive or not — this
 * test proves the sanctioned fields stay free of PII, not that no partial
 * fragment of one could ever appear.
 *
 * @module apps/api/campaign/audit-no-pii.test
 */
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc';
process.env.CAMPAIGN_DUMP_INSTANCE_ID = 'blue_dot_up';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../../services/auth/access-token.js';
import { _setNetworkConfig } from '../../services/network-config.js';
import {
  AggregatorStoreFake,
  buildAggregator,
  _setAggregatorStore,
} from '../../services/aggregator-store/index.js';
import {
  InMemoryCampaignJobStore,
  _setCampaignJobStore,
} from '../../services/campaign-job-store/index.js';
import { _setCampaignAuditWriter } from '../../services/campaign-audit/index.js';
import { CampaignAuditWriterFake, type AuditRow } from '@aggregator-dpg/campaign-audit/testing';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';

/** Distinctive values that must never appear in any audit row. */
const PII = ['Ananya Rao', 'ananya@example.org', '+919876543210'];

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

// The route only persists + enqueues; mock the queue so no real Redis is
// touched.
const { enqueueCampaignProcessMock } = vi.hoisted(() => ({
  enqueueCampaignProcessMock: vi.fn(),
}));
vi.mock('../../services/campaign-process-queue/index.js', () => ({
  enqueueCampaignProcess: enqueueCampaignProcessMock,
}));

// The rate limiter is mocked so tests never open a Redis socket.
const { consumeMock } = vi.hoisted(() => ({ consumeMock: vi.fn() }));
vi.mock('../../services/rate-limiter/index.js', () => ({
  consume: consumeMock,
}));

// S3 is mocked for the dump route — see campaign-dump.test.ts for why all
// four named exports must be present.
const { headObjectMock, signDownloadUrlMock } = vi.hoisted(() => ({
  headObjectMock: vi.fn(),
  signDownloadUrlMock: vi.fn(),
}));
vi.mock('../../services/object-storage/index.js', () => ({
  headObject: headObjectMock,
  signDownloadUrl: signDownloadUrlMock,
  signBulkUploadUrl: vi.fn(),
  signErrorsCsvDownloadUrl: vi.fn(),
}));

describe('audit rows never contain a participant PII value (#617)', () => {
  let app: FastifyInstance;
  let audit: CampaignAuditWriterFake;

  beforeEach(async () => {
    enqueueCampaignProcessMock.mockReset().mockResolvedValue(undefined);
    consumeMock.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 0 });

    headObjectMock.mockReset().mockResolvedValue({
      etag: 'e',
      contentLength: 100,
      lastModified: new Date('2026-09-02T00:00:00.000Z'),
    });
    signDownloadUrlMock.mockReset().mockImplementation(async (key: string) => ({
      url: `https://s3.public.example/${key}`,
      key,
      expiresAt: '2026-09-02T00:10:00.000Z',
    }));

    _setCampaignJobStore(new InMemoryCampaignJobStore());

    const aggStore = new AggregatorStoreFake();
    aggStore.seed([
      buildAggregator({ id: 'agg-1', contactEmail: 'aggregator@org.example', status: 'active' }),
    ]);
    _setAggregatorStore(aggStore);

    audit = new CampaignAuditWriterFake();
    _setCampaignAuditWriter(audit);

    _setNetworkConfig(buildBlueDotConfig());
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    process.env.CAMPAIGN_DUMP_INSTANCE_ID = 'blue_dot_up';
    _setAccessTokenVerifier(async (token) => {
      switch (token) {
        case 'coordinator':
          return {
            sub: 'u1',
            aggregator_id: 'agg-1',
            signalstack_org_id: 'org_5d3b7fa4-x',
            azp: 'campaign-manager',
          };
        case 'system':
          return {
            sub: 'sa-uuid',
            azp: 'campaign-manager',
            preferred_username: 'service-account-campaign-manager',
          };
        default:
          throw new Error('invalid token');
      }
    });

    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setAggregatorStore(null);
    _setCampaignJobStore(null);
    _setCampaignAuditWriter(null);
    _setNetworkConfig(null);
    vi.restoreAllMocks();
  });

  /** Submits a coordinator-scoped export request carrying `payload`. */
  function submitExport(payload: unknown) {
    return app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer coordinator' },
      payload: payload as object,
    });
  }

  /** Submits a coordinator-scoped voice-dispatch request carrying `payload`. */
  function submitVoice(payload: unknown) {
    return app.inject({
      method: 'POST',
      url: '/v1/campaign/voice',
      headers: { authorization: 'Bearer coordinator' },
      payload: payload as object,
    });
  }

  /** Issues the dump request with the system service-account token. */
  function getDump() {
    return app.inject({
      method: 'GET',
      url: '/v1/campaign/dump',
      headers: { authorization: 'Bearer system' },
    });
  }

  /** Every string reachable anywhere in a captured row, recursively. */
  function serialise(rows: AuditRow[]): string {
    return JSON.stringify(rows);
  }

  /**
   * Asserts none of {@link PII}'s values appear anywhere in `rows`, matched
   * case-insensitively (a lower/upper-cased copy of a PII value must be
   * caught, not just an exact-case one). See the module doc for the
   * substring-matching limitation this does NOT cover (truncated/transformed
   * fragments).
   */
  function assertNoPii(rows: AuditRow[]): void {
    const serialised = serialise(rows).toLowerCase();
    for (const value of PII) {
      expect(serialised).not.toContain(value.toLowerCase());
    }
  }

  it('never puts a request-supplied PII value into the requested audit row, however the caller carries it', async () => {
    // PII riding along in `content` (an opaque, per-channel object the audit
    // input never reads values from), and in a metadata key OTHER than
    // `purpose` (today's code extracts only `purpose`; any other key is
    // ignored) — the two places a future change could most plausibly start
    // forwarding a value verbatim.
    const res = await submitExport({
      item_ids: [VALID_UUID],
      metadata: [
        { key: 'purpose', value: 'quarterly outreach audit' },
        { key: 'contact_note', value: `${PII[0]} <${PII[1]}> ${PII[2]}` },
      ],
      content: {
        name: PII[0],
        email: PII[1],
        phone: PII[2],
        notes: `reach ${PII[0]} at ${PII[1]} or ${PII[2]}`,
      },
    });
    expect(res.statusCode).toBe(202);
    expect(audit.rows.filter((r) => r.kind === 'requested')).toHaveLength(1);

    assertNoPii(audit.rows);
    // The row must still carry its legitimate, sanctioned `purpose` pass
    // through — this test is about the UNsanctioned channels, not about
    // `purpose` itself being empty.
    const row = audit.rows[0] as { purpose?: string };
    expect(row.purpose).toBe('quarterly outreach audit');
  });

  it('never puts a request-supplied PII value into the dump audit row, and `details` stays to the fixed non-PII shape', async () => {
    // The dump route takes no request body, so there is no caller-supplied
    // injection vector to drive through it (unlike export/email/voice). The
    // structural assertion below is the meaningful guard here: `details` may
    // only ever be the fixed `{ files, bytes }` shape, never e.g. a sample of
    // a served object's content.
    const res = await getDump();
    expect(res.statusCode).toBe(200);
    const rows = audit.rows.filter((r) => r.kind === 'dump');
    expect(rows).toHaveLength(1);

    assertNoPii(audit.rows);

    const details = (rows[0] as { details?: Record<string, unknown> }).details;
    expect(details && Object.keys(details).sort()).toEqual(['bytes', 'files']);
    expect(typeof details?.files).toBe('number');
    expect(typeof details?.bytes).toBe('number');
  });

  it('holds across a failed dump attempt too', async () => {
    headObjectMock.mockRejectedValueOnce(new Error('s3 down'));
    const res = await getDump();
    expect(res.statusCode).toBe(503);
    const rows = audit.rows.filter((r) => r.kind === 'dump');
    expect(rows).toHaveLength(1);
    expect((rows[0] as { outcome?: string }).outcome).toBe('failed');

    assertNoPii(audit.rows);
  });

  it('never puts a request-supplied PII value into the voice audit row, even via content.variables (fix-round-1)', async () => {
    // Before `../audit-field-names.ts` existed, `campaign-voice.ts` spread
    // `content.variables` straight into `piiFields` — a live contract
    // violation, since `voiceContentSchema` leaves `variables` as
    // unvalidated free text. This drives PII through exactly that field
    // (plus the same content/metadata vectors the export case above covers)
    // and would fail against the pre-fix `piiFields`.
    const res = await submitVoice({
      item_ids: [VALID_UUID],
      metadata: [
        { key: 'purpose', value: 'quarterly outreach audit' },
        { key: 'contact_note', value: `${PII[0]} <${PII[1]}> ${PII[2]}` },
      ],
      content: {
        agent_id: 'agent-123',
        variables: ['role', PII[0], PII[1], PII[2]],
      },
    });
    expect(res.statusCode).toBe(202);
    const rows = audit.rows.filter((r) => r.kind === 'requested');
    expect(rows).toHaveLength(1);

    assertNoPii(audit.rows);

    // The row must still carry the identifier-shaped variable name AND a
    // truthful count of what was redacted — this isn't just "PII absent",
    // it's "the row still says how many fields were released".
    const piiFields = (rows[0] as { piiFields?: string[] }).piiFields ?? [];
    expect(piiFields).toContain('role');
    expect(piiFields).toContain('+3 redacted (non-identifier)');
  });
});
