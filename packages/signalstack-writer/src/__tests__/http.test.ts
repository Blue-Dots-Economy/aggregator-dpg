/**
 * Unit tests for HttpSignalStackWriter.
 *
 * Every test stubs the `fetchImpl` constructor parameter so no real network
 * call is made. The stub is a `vi.fn()` typed as `typeof fetch` so TypeScript
 * enforces the shape of the mock response object.
 *
 * @module @aggregator-dpg/signalstack-writer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpSignalStackWriter } from '../http.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal successful fetch Response stub that returns the given JSON
 * body. Only the fields the implementation reads are provided.
 */
function okJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Builds a non-2xx Response stub with a JSON error body.
 */
function errJsonResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Builds a non-2xx Response stub with a plain-text body.
 */
function errTextResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ 'content-type': 'text/plain' }),
    json: async () => {
      throw new SyntaxError('Not JSON');
    },
    text: async () => body,
  } as unknown as Response;
}

/**
 * Canonical new-shape dashboard payload used across multiple tests.
 */
const CANONICAL_DASHBOARD_PAYLOAD = {
  by_domain: {
    seeker: {
      rollup: {
        total_items: 5,
        complete_profiles: 2,
        has_applications: 3,
        by_status: { new: 1, active: 3, at_risk: 0, inactive: 1 },
        by_initiated_action_status: { create: 4, accept: 0, reject: 0, cancel: 0 },
        by_received_action_status: { create: 0, accept: 5, reject: 1, cancel: 0 },
        total_users: 4,
        avg_items_per_user: 1.25,
        avg_actions_per_user: 3.3,
        mode_wise_counts: { link: 5 },
      },
      items: [
        {
          profile_item_id: 'p-abc',
          user_id: 'u-123',
          name: 'Asha',
          item_network: 'purple_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          onboarded_via: 'link',
          profile_status: 'active',
          profile_completion_pct: 80,
          profile_created_at: '2026-01-01T00:00:00Z',
          profile_last_updated_at: '2026-01-02T00:00:00Z',
          age_days: 5,
          initiated: { create: 1, accept: 0, reject: 0, cancel: 0 },
          received: { create: 0, accept: 1, reject: 0, cancel: 0 },
          last_initiated_at: { create: '2026-01-01T00:00:00Z' },
          last_received_at: { accept: '2026-01-02T00:00:00Z' },
          actionable_tags: [],
        },
      ],
      total_matching: 5,
      next_cursor: null,
    },
  },
  metadata: {
    last_computed_at: '2026-01-01T00:00:00Z',
    ttl_seconds: 3600,
    refreshed: false,
  },
};

/** Minimal valid onboard response from signalstack Plan-C */
const ONBOARD_RESPONSE = {
  user_id: 'user-abc',
  onboarded_at: '2026-01-01T00:00:00Z',
  items: [
    {
      item_id: 'item-xyz',
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
    },
  ],
};

/** Minimal valid upsert aggregator response */
const UPSERT_AGGREGATOR_RESPONSE = {
  org_id: 'org-123',
  external_id: 'ext-abc',
  name: 'Test Aggregator',
  slug: 'test-aggregator',
};

// ---------------------------------------------------------------------------
// onboard()
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter.onboard', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  });

  it('returns ok with profile_item_id from signalstack on success', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      phoneNumber: '+919876543210',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { occupation: 'carpenter' },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.user_id).toBe('user-abc');
    expect(result.value.profile_item_id).toBe('item-xyz');
    expect(result.value.onboarded_at).toBe('2026-01-01T00:00:00Z');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when actingOrgId is missing', async () => {
    const result = await writer.onboard({
      actingOrgId: '',
      name: 'Asha',
      phoneNumber: '+919876543210',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when neither email nor phoneNumber is given', async () => {
    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('maps 400 to SIGNALSTACK_BAD_REQUEST', async () => {
    fetchMock.mockResolvedValueOnce(
      errJsonResponse(400, { error: 'INVALID_ITEM_STATE', message: 'bad profile' }),
    );

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_REQUEST');
    expect(result.error.message).toContain('400');
  });

  it('maps 401 to SIGNALSTACK_FORBIDDEN', async () => {
    fetchMock.mockResolvedValueOnce(errTextResponse(401, 'Unauthorized'));

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_FORBIDDEN');
  });

  it('returns SIGNALSTACK_TRANSPORT_FAILED when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TRANSPORT_FAILED');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when payload has no user_id', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ user_id: 42 }));

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
  });
});

// ---------------------------------------------------------------------------
// fetchDashboard() — happy path
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter.fetchDashboard — happy path', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  });

  it('returns ok with canonical new-shape payload', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(CANONICAL_DASHBOARD_PAYLOAD));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const slice = result.value.by_domain['seeker']!;
    expect(slice).toBeDefined();
    expect(Array.isArray(slice.items)).toBe(true);
    expect(slice.items).toHaveLength(1);

    // Rollup new-shape fields
    expect(slice.rollup.total_items).toBe(5);
    expect(slice.rollup.complete_profiles).toBe(2);
    expect(slice.rollup.has_applications).toBe(3);
    expect(slice.rollup.by_status).toEqual({ new: 1, active: 3, at_risk: 0, inactive: 1 });
    expect(slice.rollup.by_initiated_action_status).toEqual({
      create: 4,
      accept: 0,
      reject: 0,
      cancel: 0,
    });
    expect(slice.rollup.by_received_action_status).toEqual({
      create: 0,
      accept: 5,
      reject: 1,
      cancel: 0,
    });
    expect(slice.rollup.total_users).toBe(4);
    expect(slice.rollup.avg_items_per_user).toBe(1.25);
    expect(slice.rollup.avg_actions_per_user).toBe(3.3);
    expect(slice.rollup.mode_wise_counts).toEqual({ link: 5 });

    // Metadata
    expect(result.value.metadata.last_computed_at).toBe('2026-01-01T00:00:00Z');
    expect(result.value.metadata.ttl_seconds).toBe(3600);
    expect(result.value.metadata.refreshed).toBe(false);
  });

  it('passes x-acting-org-id header to signalstack', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(CANONICAL_DASHBOARD_PAYLOAD));

    await writer.fetchDashboard({ actingOrgId: 'org-xyz' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-acting-org-id': 'org-xyz' }),
      }),
    );
  });

  it('item row carries directional maps + identity fields', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(CANONICAL_DASHBOARD_PAYLOAD));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const item = result.value.by_domain['seeker']!.items[0]!;
    expect(item['profile_item_id']).toBe('p-abc');
    expect(item['user_id']).toBe('u-123');
    expect((item['initiated'] as Record<string, number>)['create']).toBe(1);
    expect((item['received'] as Record<string, number>)['accept']).toBe(1);
    expect((item['last_initiated_at'] as Record<string, string>)['create']).toBe(
      '2026-01-01T00:00:00Z',
    );
    expect((item['last_received_at'] as Record<string, string>)['accept']).toBe(
      '2026-01-02T00:00:00Z',
    );
    // Sparse maps omit buckets that never occurred.
    expect((item['last_initiated_at'] as Record<string, string>)['reject']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchDashboard() — refresh URL forwarding
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter.fetchDashboard — refresh flag', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  });

  it('appends ?refresh=true when query.refresh is true', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(CANONICAL_DASHBOARD_PAYLOAD));

    await writer.fetchDashboard({ actingOrgId: 'org-abc', refresh: true });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('refresh=true'),
      expect.anything(),
    );
  });

  it('does NOT append refresh when query.refresh is unset', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(CANONICAL_DASHBOARD_PAYLOAD));

    await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.not.stringContaining('refresh='),
      expect.anything(),
    );
  });

  it('does NOT append refresh when query.refresh is false', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(CANONICAL_DASHBOARD_PAYLOAD));

    await writer.fetchDashboard({ actingOrgId: 'org-abc', refresh: false });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.not.stringContaining('refresh='),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// fetchDashboard() — validation failures (malformed upstream payloads)
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter.fetchDashboard — malformed payload', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when by_domain is missing', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ metadata: {} }));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when metadata is missing', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        by_domain: {
          seeker: { rollup: { total_items: 0, by_action_status: {}, by_status: {} }, items: [] },
        },
      }),
    );

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when a domain slice lacks items[]', async () => {
    const payload = {
      by_domain: {
        seeker: {
          // items is missing
          rollup: {
            total_items: 0,
            by_action_status: {},
            by_status: {},
          },
          total_matching: 0,
          next_cursor: null,
        },
      },
      metadata: { last_computed_at: '2026-01-01T00:00:00Z', ttl_seconds: 3600, refreshed: false },
    };

    fetchMock.mockResolvedValueOnce(okJsonResponse(payload));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
    expect(result.error.message).toContain('items');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when rollup is missing', async () => {
    const payload = {
      by_domain: {
        seeker: {
          items: [],
          // rollup is missing
          total_matching: 0,
          next_cursor: null,
        },
      },
      metadata: { last_computed_at: '2026-01-01T00:00:00Z', ttl_seconds: 3600, refreshed: false },
    };

    fetchMock.mockResolvedValueOnce(okJsonResponse(payload));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when rollup is missing by_initiated_action_status', async () => {
    const payload = {
      by_domain: {
        seeker: {
          items: [],
          rollup: {
            total_items: 0,
            // by_initiated_action_status is missing
            by_received_action_status: {},
            by_status: { new: 0 },
          },
          total_matching: 0,
          next_cursor: null,
        },
      },
      metadata: { last_computed_at: '2026-01-01T00:00:00Z', ttl_seconds: 3600, refreshed: false },
    };

    fetchMock.mockResolvedValueOnce(okJsonResponse(payload));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
    expect(result.error.message).toContain('by_initiated_action_status');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when rollup is missing total_items', async () => {
    const payload = {
      by_domain: {
        seeker: {
          items: [],
          rollup: {
            // total_items is missing
            by_action_status: {},
            by_status: {},
          },
          total_matching: 0,
          next_cursor: null,
        },
      },
      metadata: { last_computed_at: '2026-01-01T00:00:00Z', ttl_seconds: 3600, refreshed: false },
    };

    fetchMock.mockResolvedValueOnce(okJsonResponse(payload));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
    expect(result.error.message).toContain('total_items');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when actingOrgId is empty', async () => {
    const result = await writer.fetchDashboard({ actingOrgId: '' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('maps 503 to SIGNALSTACK_SERVER_ERROR', async () => {
    fetchMock.mockResolvedValueOnce(errTextResponse(503, 'Service Unavailable'));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_SERVER_ERROR');
  });

  it('returns SIGNALSTACK_TRANSPORT_FAILED on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TRANSPORT_FAILED');
  });
});

// ---------------------------------------------------------------------------
// exportDashboardCsv()
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter.exportDashboardCsv', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  });

  it('returns ok with csv and filename on success', async () => {
    const csvBody = 'name,status\nAsha,active';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => csvBody,
    } as unknown as Response);

    const result = await writer.exportDashboardCsv({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.csv).toBe(csvBody);
    expect(result.value.filename).toMatch(/^aggregator-dashboard-all-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('appends ?refresh=true when refresh is true', async () => {
    const csvBody = 'name,status\nAsha,active';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => csvBody,
    } as unknown as Response);

    await writer.exportDashboardCsv({ actingOrgId: 'org-abc', refresh: true });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('refresh=true'),
      expect.anything(),
    );
  });

  it('does NOT append refresh when refresh is unset', async () => {
    const csvBody = 'name,status\nAsha,active';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => csvBody,
    } as unknown as Response);

    await writer.exportDashboardCsv({ actingOrgId: 'org-abc' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.not.stringContaining('refresh='),
      expect.anything(),
    );
  });

  it('returns SIGNALSTACK_INPUT_INVALID when actingOrgId is missing', async () => {
    const result = await writer.exportDashboardCsv({ actingOrgId: '' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when csv body is empty', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
    } as unknown as Response);

    const result = await writer.exportDashboardCsv({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
  });
});

// ---------------------------------------------------------------------------
// upsertAggregator()
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter.upsertAggregator', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      actingOrgId: 'platform-org-1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  });

  it('returns ok with org_id on success', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(UPSERT_AGGREGATOR_RESPONSE));

    const result = await writer.upsertAggregator({
      external_id: 'ext-abc',
      name: 'Test Aggregator',
      slug: 'test-aggregator',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.org_id).toBe('org-123');
  });

  it('returns SIGNALSTACK_CONFIG_MISSING when actingOrgId is not configured', async () => {
    const writerNoOrg = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await writerNoOrg.upsertAggregator({
      external_id: 'ext-abc',
      name: 'Test',
      slug: 'test',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_CONFIG_MISSING');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when external_id is missing', async () => {
    const result = await writer.upsertAggregator({
      external_id: '',
      name: 'Test',
      slug: 'test',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when org_id is missing from payload', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ external_id: 'ext-abc', name: 'Test' }));

    const result = await writer.upsertAggregator({
      external_id: 'ext-abc',
      name: 'Test',
      slug: 'test',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
  });
});

// ---------------------------------------------------------------------------
// listItemsByAggregator()
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter.listItemsByAggregator', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  });

  it('returns ok with items list on success', async () => {
    const payload = {
      meta: { total: 1, limit: 50, offset: 0 },
      items: [
        {
          item_id: 'item-1',
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          item_state: {},
          item_latitude: null,
          item_longitude: null,
          aggregator_id: 'agg-1',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    };
    fetchMock.mockResolvedValueOnce(okJsonResponse(payload));

    const result = await writer.listItemsByAggregator({
      aggregator_id: 'agg-1',
      item_network: 'blue_dot',
      item_domain: 'seeker',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.items).toHaveLength(1);
    expect(result.value.meta.total).toBe(1);
  });

  it('returns SIGNALSTACK_INPUT_INVALID when required fields are missing', async () => {
    const result = await writer.listItemsByAggregator({
      aggregator_id: '',
      item_network: 'blue_dot',
      item_domain: 'seeker',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });
});
