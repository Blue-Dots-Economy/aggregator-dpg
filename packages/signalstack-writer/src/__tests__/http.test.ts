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
// constructor
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter constructor', () => {
  it('throws when baseUrl is missing', () => {
    expect(
      () =>
        new HttpSignalStackWriter({
          baseUrl: '',
          apiKey: 'test-key',
        }),
    ).toThrow('HttpSignalStackWriter requires baseUrl');
  });

  it('throws when apiKey is missing', () => {
    expect(
      () =>
        new HttpSignalStackWriter({
          baseUrl: 'http://signalstack.test',
          apiKey: '',
        }),
    ).toThrow('HttpSignalStackWriter requires either apiKey or tokenProvider');
  });
});

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
      // Single-attempt: these suites assert the one-shot status/transport
      // mapping. Retry/backoff behaviour is covered in its own describe below.
      maxRetries: 0,
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

  it('forwards the compliance array + age and never the deprecated consent flags', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));

    await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      phoneNumber: '+919876543210',
      age: 27,
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: true },
        { key: 'profile_creation', value: true },
      ],
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { occupation: 'carpenter' },
    });

    const sentBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(sentBody.compliance).toEqual([
      { key: 'user_terms', value: true },
      { key: 'user_privacy', value: true },
      { key: 'profile_creation', value: true },
    ]);
    expect(sentBody.age).toBe(27);
    // Deprecated flags must never leave the writer.
    expect(sentBody).not.toHaveProperty('terms_accepted');
    expect(sentBody).not.toHaveProperty('privacy_accepted');
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

  // Regression: account_only always returns an empty `items` array (signals
  // creates the user row only). The with-item owned-elsewhere heuristic keys
  // off empty-items, so account_only MUST be classified before it — otherwise
  // a returning own-aggregator user (user_existed:true) is misread as
  // owned_elsewhere. See dashboard 4.2.
  const ACCOUNT_ONLY_INPUT = {
    actingOrgId: 'org-abc',
    name: 'Asha',
    phoneNumber: '+919876543210',
    terms_accepted: true,
    privacy_accepted: true,
    channel: 'link' as const,
    source_id: 'link-1',
    network: 'blue_dot',
    domain: 'seeker',
    item_type: 'profile_1.0',
    profile: {},
    submit_mode: 'account_only' as const,
  };

  it('account_only fresh user → owned_elsewhere=false, not already_registered', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({ user_id: 'u-1', user_existed: false, owned_elsewhere: false, items: [] }),
    );
    const result = await writer.onboard(ACCOUNT_ONLY_INPUT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.owned_elsewhere).toBe(false);
    expect(result.value.already_registered ?? false).toBe(false);
    expect(result.value.profile_item_id).toBe('');
  });

  it('account_only re-submit of own user (user_existed) → idempotent success, not skipped/owned_elsewhere', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({ user_id: 'u-1', user_existed: true, owned_elsewhere: false, items: [] }),
    );
    const result = await writer.onboard(ACCOUNT_ONLY_INPUT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Repeat phone is idempotent success — must NOT flag already_registered
    // (which the caller maps to a 409 skip) nor owned_elsewhere.
    expect(result.value.owned_elsewhere).toBe(false);
    expect(result.value.already_registered ?? false).toBe(false);
  });

  it('account_only genuinely foreign user (owned_elsewhere signal) → owned_elsewhere=true', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({ user_id: 'u-1', user_existed: true, owned_elsewhere: true, items: [] }),
    );
    const result = await writer.onboard(ACCOUNT_ONLY_INPUT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.owned_elsewhere).toBe(true);
  });

  // -------------------------------------------------------------------------
  // guardInput() branches — every required-field gap must surface
  // SIGNALSTACK_INPUT_INVALID before a request ever leaves the process.
  // -------------------------------------------------------------------------

  it('returns SIGNALSTACK_INPUT_INVALID when name is missing', async () => {
    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: '',
      email: 'asha@example.com',
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
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns SIGNALSTACK_INPUT_INVALID when network/domain/item_type are missing', async () => {
    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'link',
      source_id: 'link-1',
      network: '',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when channel/source_id are missing', async () => {
    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: '' as unknown as 'link',
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

  it('returns SIGNALSTACK_INPUT_INVALID when profile is missing', async () => {
    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
    } as never);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  // -------------------------------------------------------------------------
  // with_item response-shape branches
  // -------------------------------------------------------------------------

  it('with_item: user_existed with empty items → already_registered + owned_elsewhere', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'u-1',
        user_existed: true,
        onboarded_at: '2026-01-01T00:00:00Z',
        items: [],
      }),
    );

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.already_registered).toBe(true);
    expect(result.value.owned_elsewhere).toBe(true);
    expect(result.value.profile_item_id).toBe('');
  });

  it('with_item: fresh user with empty items → SIGNALSTACK_BAD_RESPONSE (no item for request)', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'u-1',
        user_existed: false,
        onboarded_at: '2026-01-01T00:00:00Z',
        items: [],
      }),
    );

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
    expect(result.error.message).toContain('no item');
  });

  it('surfaces the matched item lifecycle_status when present', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'u-1',
        onboarded_at: '2026-01-01T00:00:00Z',
        items: [
          {
            item_id: 'item-xyz',
            item_network: 'blue_dot',
            item_domain: 'seeker',
            item_type: 'profile_1.0',
            lifecycle_status: 'draft',
          },
        ],
      }),
    );

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.lifecycle_status).toBe('draft');
  });

  // -------------------------------------------------------------------------
  // Error-body extraction branches
  // -------------------------------------------------------------------------

  it('distinguishes the per-user profile cap (409 + PROFILE_LIMIT_REACHED)', async () => {
    fetchMock.mockResolvedValueOnce(
      errJsonResponse(409, { error: 'PROFILE_LIMIT_REACHED', message: 'cap hit' }),
    );

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_PROFILE_LIMIT_REACHED');
  });

  it('distinguishes a coordinate outside the country (400 + LOCATION_OUTSIDE_COUNTRY, signals-dpg#789)', async () => {
    fetchMock.mockResolvedValueOnce(
      errJsonResponse(400, {
        error: 'LOCATION_OUTSIDE_COUNTRY',
        message: 'Location 23.8103, 90.4125 is outside the allowed region (IN).',
      }),
    );

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
      item_locations: [{ lat: 23.8103, lng: 90.4125 }],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_LOCATION_OUTSIDE_COUNTRY');
    expect(result.error.message).toContain('outside the allowed region (IN)');
  });

  it("forwards Signals' error code and per-field map on the error details", async () => {
    fetchMock.mockResolvedValueOnce(
      errJsonResponse(400, {
        error: 'INVALID_ITEM_STATE',
        message: 'Invalid item_state: mobile_number: Enter a 10-digit mobile number',
        fields: { mobile_number: 'Enter a 10-digit mobile number' },
      }),
    );

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.details).toMatchObject({
      upstreamCode: 'INVALID_ITEM_STATE',
      signalsFields: { mobile_number: 'Enter a 10-digit mobile number' },
      signalsMessage: 'Invalid item_state: mobile_number: Enter a 10-digit mobile number',
    });
  });

  it("reads a Fastify request-validation error's `code`, not its generic `error`", async () => {
    fetchMock.mockResolvedValueOnce(
      errJsonResponse(400, {
        statusCode: 400,
        code: 'FST_ERR_VALIDATION',
        error: 'Bad Request',
        message: 'body/email Invalid email address',
      }),
    );

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.details).toMatchObject({ upstreamCode: 'FST_ERR_VALIDATION' });
  });

  it('combines a nested { error: { code, message } } body into one message', async () => {
    fetchMock.mockResolvedValueOnce(
      errJsonResponse(422, { error: { code: 'FANCY_CODE', message: 'fancy message' } }),
    );

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain('FANCY_CODE');
    expect(result.error.message).toContain('fancy message');
    expect((result.error.details as { signalsMessage?: string })?.signalsMessage).toBe(
      'fancy message',
    );
  });

  it('falls back to the bare status message when the error body has no error/message fields', async () => {
    fetchMock.mockResolvedValueOnce(errJsonResponse(500, {}));

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe('signalstack onboard returned 500');
  });

  it('treats a body read failure as an empty body rather than throwing', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError('unreadable');
      },
      text: async () => {
        throw new Error('stream already consumed');
      },
    } as unknown as Response);

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_SERVER_ERROR');
  });

  it('maps an aborted (timed-out) request to SIGNALSTACK_TIMEOUT', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abortError);

    const result = await writer.onboard({
      actingOrgId: 'org-abc',
      name: 'Asha',
      email: 'asha@example.com',
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TIMEOUT');
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
      // Single-attempt: these suites assert the one-shot status/transport
      // mapping. Retry/backoff behaviour is covered in its own describe below.
      maxRetries: 0,
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
      // Single-attempt: these suites assert the one-shot status/transport
      // mapping. Retry/backoff behaviour is covered in its own describe below.
      maxRetries: 0,
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

  it('forwards a comma-separated ?lifecycle= filter when provided', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(CANONICAL_DASHBOARD_PAYLOAD));

    await writer.fetchDashboard({ actingOrgId: 'org-abc', lifecycle: ['live', 'paused'] });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('lifecycle=live%2Cpaused');
  });

  it('does NOT append lifecycle when unset or empty', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(CANONICAL_DASHBOARD_PAYLOAD));

    await writer.fetchDashboard({ actingOrgId: 'org-abc', lifecycle: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.not.stringContaining('lifecycle='),
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
      // Single-attempt: these suites assert the one-shot status/transport
      // mapping. Retry/backoff behaviour is covered in its own describe below.
      maxRetries: 0,
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
          seeker: {
            rollup: {
              total_items: 0,
              by_initiated_action_status: {},
              by_received_action_status: {},
              by_status: {},
            },
            items: [],
          },
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
            by_initiated_action_status: {},
            by_received_action_status: {},
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
            by_initiated_action_status: {},
            by_received_action_status: {},
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

  it('returns SIGNALSTACK_BAD_RESPONSE when a domain slice is not an object', async () => {
    const payload = {
      by_domain: { seeker: 'not-an-object' },
      metadata: { last_computed_at: '2026-01-01T00:00:00Z', ttl_seconds: 3600, refreshed: false },
    };
    fetchMock.mockResolvedValueOnce(okJsonResponse(payload));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
    expect(result.error.message).toContain('by_domain.seeker (invalid_type)');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when rollup is missing by_received_action_status', async () => {
    const payload = {
      by_domain: {
        seeker: {
          items: [],
          rollup: {
            total_items: 0,
            by_initiated_action_status: {},
            // by_received_action_status is missing
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
    expect(result.error.message).toContain('by_received_action_status');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when rollup is missing by_status', async () => {
    const payload = {
      by_domain: {
        seeker: {
          items: [],
          rollup: {
            total_items: 0,
            by_initiated_action_status: {},
            by_received_action_status: {},
            // by_status is missing
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
    expect(result.error.message).toContain('by_status');
  });

  it('returns a bare status message when the non-ok body carries no upstream message', async () => {
    fetchMock.mockResolvedValueOnce(errTextResponse(500, ''));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe('signalstack dashboard returned 500');
  });

  it('maps an aborted (timed-out) request to SIGNALSTACK_TIMEOUT', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abortError);

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TIMEOUT');
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
      // Single-attempt: these suites assert the one-shot status/transport
      // mapping. Retry/backoff behaviour is covered in its own describe below.
      maxRetries: 0,
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

  it('maps a non-2xx response to UpstreamError', async () => {
    fetchMock.mockResolvedValueOnce(errJsonResponse(503, { error: 'DOWN', message: 'try later' }));

    const result = await writer.exportDashboardCsv({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_SERVER_ERROR');
    expect(result.error.message).toContain('try later');
  });

  it('falls back to a bare status message when the error body has no upstream message', async () => {
    fetchMock.mockResolvedValueOnce(errTextResponse(500, ''));

    const result = await writer.exportDashboardCsv({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe('signalstack dashboard export returned 500');
  });

  it('returns SIGNALSTACK_TRANSPORT_FAILED when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const result = await writer.exportDashboardCsv({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TRANSPORT_FAILED');
  });

  it('maps an aborted (timed-out) request to SIGNALSTACK_TIMEOUT', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abortError);

    const result = await writer.exportDashboardCsv({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TIMEOUT');
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
      maxRetries: 0,
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

  it('maps a non-2xx response to UpstreamError', async () => {
    fetchMock.mockResolvedValueOnce(
      errJsonResponse(409, { error: 'DUPLICATE_SLUG', message: 'slug taken' }),
    );

    const result = await writer.upsertAggregator({
      external_id: 'ext-abc',
      name: 'Test Aggregator',
      slug: 'test-aggregator',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_CONFLICT');
    expect(result.error.message).toContain('slug taken');
  });

  it('falls back to a bare status message when the error body has no upstream message', async () => {
    fetchMock.mockResolvedValueOnce(errTextResponse(500, ''));

    const result = await writer.upsertAggregator({
      external_id: 'ext-abc',
      name: 'Test Aggregator',
      slug: 'test-aggregator',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe('signalstack aggregator upsert returned 500');
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

  it('returns SIGNALSTACK_TRANSPORT_FAILED when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const result = await writer.upsertAggregator({
      external_id: 'ext-abc',
      name: 'Test',
      slug: 'test',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TRANSPORT_FAILED');
  });

  it('maps an aborted (timed-out) request to SIGNALSTACK_TIMEOUT', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abortError);

    const result = await writer.upsertAggregator({
      external_id: 'ext-abc',
      name: 'Test',
      slug: 'test',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TIMEOUT');
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// requestWithRetry — transient-failure retry/backoff (error-handling.md rule)
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter — retry/backoff', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 2,
      retryBaseMs: 0, // no real delay in tests
    });
  });

  it('retries a 5xx and succeeds on the next attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(errTextResponse(503, 'Service Unavailable'))
      .mockResolvedValueOnce(okJsonResponse(CANONICAL_DASHBOARD_PAYLOAD));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 and succeeds on the next attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(errTextResponse(429, 'Too Many Requests'))
      .mockResolvedValueOnce(okJsonResponse(CANONICAL_DASHBOARD_PAYLOAD));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries on a persistent 5xx and maps the final status', async () => {
    fetchMock.mockResolvedValue(errTextResponse(500, 'Internal Server Error'));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_SERVER_ERROR');
    // maxRetries (2) + initial attempt = 3 total.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a thrown transport error and succeeds on the next attempt', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(okJsonResponse(CANONICAL_DASHBOARD_PAYLOAD));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries on a persistent transport error → SIGNALSTACK_TRANSPORT_FAILED', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TRANSPORT_FAILED');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-transient 4xx (400)', async () => {
    fetchMock.mockResolvedValue(errJsonResponse(400, { error: 'BAD' }));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_REQUEST');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('actually waits a positive backoff delay between attempts', async () => {
    const delayedWriter = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 1,
      retryBaseMs: 5, // small but > 0 so the real setTimeout branch runs
    });
    fetchMock
      .mockResolvedValueOnce(errTextResponse(503, 'Service Unavailable'))
      .mockResolvedValueOnce(okJsonResponse(CANONICAL_DASHBOARD_PAYLOAD));

    const result = await delayedWriter.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// probeUser() — http-level reshape + back-compat (no fake)
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter.probeUser (http)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  const PROBE_INPUT = {
    actingOrgId: 'org-abc',
    email: 'asha@example.com',
    network: 'blue_dot',
    domain: 'seeker',
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });
  });

  it('reports a new user (user_id null) with no lifecycle leak', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ user_id: null, items: [] }));

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.user_exists).toBe(false);
    expect(result.value.owned_elsewhere).toBe(false);
    expect(result.value.lifecycle_summary).toBeNull();
  });

  it('reshapes an own user with a draft item in the probed domain into lifecycle_summary', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'u-1',
        items: [
          {
            item_id: 'item-1',
            item_network: 'blue_dot',
            item_domain: 'seeker',
            lifecycle_status: 'draft',
          },
        ],
      }),
    );

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.user_exists).toBe(true);
    expect(result.value.owned_elsewhere).toBe(false);
    expect(result.value.lifecycle_summary?.primary_item.item_id).toBe('item-1');
    expect(result.value.lifecycle_summary?.primary_item.lifecycle_status).toBe('draft');
  });

  it('back-compat: an item with ABSENT lifecycle_status defaults to live', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'u-1',
        // no lifecycle_status (older signals build)
        items: [{ item_id: 'item-1', item_network: 'blue_dot', item_domain: 'seeker' }],
      }),
    );

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.lifecycle_summary?.primary_item.lifecycle_status).toBe('live');
  });

  it('scopes the primary item to the probed domain — an item in ANOTHER domain is not surfaced', async () => {
    // Own user with a paused item in `provider`, nothing in the probed `seeker`.
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'u-1',
        items: [
          {
            item_id: 'prov-1',
            item_network: 'blue_dot',
            item_domain: 'provider',
            lifecycle_status: 'paused',
          },
        ],
      }),
    );

    const result = await writer.probeUser(PROBE_INPUT); // domain: 'seeker'

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Own user (this org owns items) but nothing in `seeker` → no summary, and
    // NOT owned_elsewhere (must not report the provider item's paused lifecycle).
    expect(result.value.user_exists).toBe(true);
    expect(result.value.owned_elsewhere).toBe(false);
    expect(result.value.lifecycle_summary).toBeNull();
  });

  it('a retired item in the probed domain surfaces no resumable lifecycle', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'u-1',
        items: [
          {
            item_id: 'old-1',
            item_network: 'blue_dot',
            item_domain: 'seeker',
            lifecycle_status: 'retired',
          },
        ],
      }),
    );

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.user_exists).toBe(true);
    expect(result.value.owned_elsewhere).toBe(false);
    expect(result.value.lifecycle_summary).toBeNull();
  });

  it('rejects an unknown lifecycle_status as SIGNALSTACK_BAD_RESPONSE (not coerced to live)', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'u-1',
        items: [
          {
            item_id: 'item-1',
            item_network: 'blue_dot',
            item_domain: 'seeker',
            lifecycle_status: 'archived', // unexpected future/garbage value
          },
        ],
      }),
    );

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
  });

  it('rejects a response whose items field is missing/non-array as SIGNALSTACK_BAD_RESPONSE', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ user_id: 'u-1' })); // no items array

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
  });

  it('user exists but this org owns no items → owned_elsewhere, no lifecycle leak', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ user_id: 'u-1', items: [] }));

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.user_exists).toBe(true);
    expect(result.value.owned_elsewhere).toBe(true);
    expect(result.value.lifecycle_summary).toBeNull();
  });

  it('matches a phone-only identity (omits email= from the query)', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ user_id: null, items: [] }));

    await writer.probeUser({
      actingOrgId: 'org-abc',
      phoneNumber: '+919000000002',
      network: 'blue_dot',
      domain: 'seeker',
    });

    const [calledUrl] = fetchMock.mock.calls[0]!;
    const urlStr = String(calledUrl);
    expect(urlStr).toContain('phone_number=%2B919000000002');
    expect(urlStr).not.toContain('email=');
  });

  it('issues a read-only GET with identity query params and no body or lookup sentinel', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ user_id: null, items: [] }));

    await writer.probeUser({ ...PROBE_INPUT, phoneNumber: '+919000000001' });

    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe('GET');
    // No write body — the phantom-user regression (#648) was the POST body.
    expect((init as RequestInit).body).toBeUndefined();
    // x-acting-org-id is now the SOLE org-scoping mechanism — assert it is sent
    // so a dropped/renamed header can't silently return the wrong org's items.
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-acting-org-id']).toBe('org-abc');
    const urlStr = String(calledUrl);
    expect(urlStr).toContain('/admin/participant?');
    expect(urlStr).toContain('email=asha%40example.com');
    expect(urlStr).toContain('phone_number=%2B919000000001');
    expect(urlStr).not.toContain('lookup');
  });

  it('maps a 400 to a ValidationError with SIGNALSTACK_BAD_REQUEST', async () => {
    fetchMock.mockResolvedValueOnce(errJsonResponse(400, { error: 'BAD_EMAIL' }));

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_REQUEST');
    expect(result.error.name).toBe('ValidationError');
  });

  it('maps a 401 to SIGNALSTACK_FORBIDDEN', async () => {
    fetchMock.mockResolvedValueOnce(errTextResponse(401, 'Unauthorized'));

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_FORBIDDEN');
  });

  it('returns a ValidationError when neither email nor phoneNumber is given', async () => {
    const result = await writer.probeUser({
      actingOrgId: 'org-abc',
      network: 'blue_dot',
      domain: 'seeker',
    } as never);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('ValidationError');
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('returns SIGNALSTACK_TRANSPORT_FAILED when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TRANSPORT_FAILED');
  });

  it('returns a ValidationError when actingOrgId is missing', async () => {
    const result = await writer.probeUser({
      email: 'asha@example.com',
      network: 'blue_dot',
      domain: 'seeker',
    } as never);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('ValidationError');
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a ValidationError when network/domain are missing', async () => {
    const result = await writer.probeUser({
      actingOrgId: 'org-abc',
      email: 'asha@example.com',
    } as never);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('maps a status with no dedicated branch (e.g. 418) to SIGNALSTACK_UPSTREAM_ERROR and falls back to a bare message when the body is empty', async () => {
    fetchMock.mockResolvedValueOnce(errTextResponse(418, ''));

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_UPSTREAM_ERROR');
    expect(result.error.message).toBe('signalstack probe returned 418');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when the payload is not an object', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(null));

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when the probed-domain item is missing item_id', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'u-1',
        items: [{ item_network: 'blue_dot', item_domain: 'seeker', lifecycle_status: 'live' }],
      }),
    );

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
    expect(result.error.message).toContain('item_id');
  });

  it('maps an aborted (timed-out) request to SIGNALSTACK_TIMEOUT', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abortError);

    const result = await writer.probeUser(PROBE_INPUT);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TIMEOUT');
  });
});

// ---------------------------------------------------------------------------
// fetchDecryptedProfiles()
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter.fetchDecryptedProfiles', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });
  });

  it('posts item_ids with the acting-org header and returns profiles + skipped', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        profiles: [
          {
            item_id: 'item-1',
            item_network: 'blue_dot',
            item_domain: 'seeker',
            item_type: 'profile_1.0',
            item_state: { name: 'Velu Murugan', phone: '+91987' },
            created_at: '2026-06-26T12:03:04.686Z',
            updated_at: '2026-06-26T12:03:04.686Z',
          },
        ],
        skipped: ['item-2'],
      }),
    );

    const result = await writer.fetchDecryptedProfiles({
      actingOrgId: 'org-abc',
      itemIds: ['item-1', 'item-2'],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.profiles).toHaveLength(1);
    expect(result.value.profiles[0]!.item_state.name).toBe('Velu Murugan');
    expect(result.value.skipped).toEqual(['item-2']);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://signalstack.test/api/v1/admin/participant/decrypt');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-acting-org-id']).toBe('org-abc');
    expect(headers['x-api-key']).toBe('test-key');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      item_ids: ['item-1', 'item-2'],
    });
  });

  it('returns ValidationError when actingOrgId is missing', async () => {
    const result = await writer.fetchDecryptedProfiles({ actingOrgId: '', itemIds: ['item-1'] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ValidationError when itemIds is empty', async () => {
    const result = await writer.fetchDecryptedProfiles({ actingOrgId: 'org-abc', itemIds: [] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a non-2xx response to UpstreamError', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'BOOM', message: 'nope' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await writer.fetchDecryptedProfiles({
      actingOrgId: 'org-abc',
      itemIds: ['item-1'],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('UpstreamError');
  });

  it('falls back to a bare status message when the error body has no upstream message', async () => {
    fetchMock.mockResolvedValueOnce(errTextResponse(500, ''));

    const result = await writer.fetchDecryptedProfiles({
      actingOrgId: 'org-abc',
      itemIds: ['item-1'],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe('signalstack decrypt returned 500');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when profiles/skipped are missing from the body', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ profiles: 'nope' }));

    const result = await writer.fetchDecryptedProfiles({
      actingOrgId: 'org-abc',
      itemIds: ['item-1'],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
  });

  it('returns SIGNALSTACK_TRANSPORT_FAILED when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection reset'));

    const result = await writer.fetchDecryptedProfiles({
      actingOrgId: 'org-abc',
      itemIds: ['item-1'],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TRANSPORT_FAILED');
  });

  it('maps an aborted (timed-out) request to SIGNALSTACK_TIMEOUT', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abortError);

    const result = await writer.fetchDecryptedProfiles({
      actingOrgId: 'org-abc',
      itemIds: ['item-1'],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TIMEOUT');
  });
});

// ---------------------------------------------------------------------------
// Correlation id (x-request-id) forwarding — PLAN 2.4
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter correlation-id forwarding', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      actingOrgId: 'org-default',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });
  });

  /** Reads the headers object of the Nth captured fetch call. */
  function headersOf(callIndex = 0): Record<string, string> {
    return (fetchMock.mock.calls[callIndex]?.[1]?.headers ?? {}) as Record<string, string>;
  }

  it('forwards x-request-id when requestId is set on the input', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));
    await writer.onboard({
      actingOrgId: 'org-abc',
      requestId: 'trace-xyz-1',
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
    expect(headersOf()['x-request-id']).toBe('trace-xyz-1');
    // The existing headers are still present.
    expect(headersOf()['x-acting-org-id']).toBe('org-abc');
    expect(headersOf()['x-api-key']).toBe('test-key');
  });

  it('omits x-request-id when requestId is absent', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));
    await writer.onboard({
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
    expect('x-request-id' in headersOf()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Response contract: the shapes Signals sends, and what a bad response carries
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter — Signals response contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  /** A participant value that must never reach an error's details. */
  const PARTICIPANT_PHONE = '+919800000001';

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      actingOrgId: 'platform-org-1',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });
  });

  const onboardInput = {
    actingOrgId: 'org-abc',
    name: 'Asha',
    phoneNumber: PARTICIPANT_PHONE,
    channel: 'bulk' as const,
    source_id: 'src-1',
    network: 'blue_dot',
    domain: 'seeker',
    item_type: 'profile_1.0',
    profile: { name: 'Asha' },
  };

  it('upsertAggregator builds the aggregator from the input when Signals returns { org_id, created }', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ org_id: 'org_1', created: true }));

    const result = await writer.upsertAggregator({
      external_id: 'ext-abc',
      name: 'Test Aggregator',
      slug: 'test-aggregator',
      metadata: { region: 'south' },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({
      org_id: 'org_1',
      external_id: 'ext-abc',
      name: 'Test Aggregator',
      slug: 'test-aggregator',
      metadata: { region: 'south' },
    });
  });

  it('onboard accepts the full Signals response, including a null onboarded_at', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'user-1',
        user_existed: false,
        owned_elsewhere: false,
        onboarded_at: null,
        consent_recorded: 2,
        onboarded_by_org_id: 'org_1',
        onboarded_by_default: false,
        items: [
          {
            item_id: '0b8c2f7e-1d3a-4c1e-9a4e-6f1b2c3d4e5f',
            item_network: 'blue_dot',
            item_domain: 'seeker',
            item_type: 'profile_1.0',
            lifecycle_status: 'draft',
            item_state: { phone: PARTICIPANT_PHONE },
            item_locations: [],
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );

    const result = await writer.onboard(onboardInput);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({
      user_id: 'user-1',
      profile_item_id: '0b8c2f7e-1d3a-4c1e-9a4e-6f1b2c3d4e5f',
      onboarded_at: '',
      owned_elsewhere: false,
      lifecycle_status: 'draft',
    });
  });

  it('onboard reports the field path and code of a malformed response, never its values', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({ items: [{ item_id: 'item-1', item_state: { phone: PARTICIPANT_PHONE } }] }),
    );

    const result = await writer.onboard(onboardInput);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
    expect(result.error.details).toEqual({ issues: [{ path: 'user_id', code: 'invalid_type' }] });
    expect(JSON.stringify(result.error.toJSON())).not.toContain(PARTICIPANT_PHONE);
  });

  it('onboard does not put participant data on the "no item" error', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'user-1',
        items: [{ item_network: 'blue_dot', item_state: { phone: PARTICIPANT_PHONE } }],
      }),
    );

    const result = await writer.onboard(onboardInput);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
    expect(JSON.stringify(result.error.toJSON())).not.toContain(PARTICIPANT_PHONE);
  });

  it('probeUser does not put participant data on a bad-response error', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'user-1',
        compliance: [],
        items: [
          {
            item_network: 'blue_dot',
            item_domain: 'seeker',
            item_state: { phone: PARTICIPANT_PHONE },
          },
        ],
      }),
    );

    const result = await writer.probeUser({
      actingOrgId: 'org-abc',
      phoneNumber: PARTICIPANT_PHONE,
      network: 'blue_dot',
      domain: 'seeker',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
    expect(JSON.stringify(result.error.toJSON())).not.toContain(PARTICIPANT_PHONE);
  });

  it('probeUser reports the field path of a non-array items field', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ user_id: 'user-1', items: 'nope' }));

    const result = await writer.probeUser({
      actingOrgId: 'org-abc',
      email: 'asha@example.com',
      network: 'blue_dot',
      domain: 'seeker',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
    expect(result.error.details).toEqual({ issues: [{ path: 'items', code: 'invalid_type' }] });
  });

  it('fetchDashboard accepts a null last_computed_at and keeps fields it does not model', async () => {
    const payload = {
      ...CANONICAL_DASHBOARD_PAYLOAD,
      by_domain: {
        seeker: {
          ...CANONICAL_DASHBOARD_PAYLOAD.by_domain.seeker,
          rollup: { ...CANONICAL_DASHBOARD_PAYLOAD.by_domain.seeker.rollup, extra_metric: 7 },
          extra_slice_field: 'kept',
        },
      },
      metadata: { last_computed_at: null, ttl_seconds: 3600, refreshed: true },
      extra_top_field: { kept: true },
    };
    fetchMock.mockResolvedValueOnce(okJsonResponse(payload));

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual(payload);
  });

  it('fetchDashboard rejects a rollup without total_users and names the path', async () => {
    const { total_users: _omitted, ...rollup } =
      CANONICAL_DASHBOARD_PAYLOAD.by_domain.seeker.rollup;
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        ...CANONICAL_DASHBOARD_PAYLOAD,
        by_domain: { seeker: { ...CANONICAL_DASHBOARD_PAYLOAD.by_domain.seeker, rollup } },
      }),
    );

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
    expect(result.error.details).toEqual({
      issues: [{ path: 'by_domain.seeker.rollup.total_users', code: 'invalid_type' }],
    });
  });

  it('fetchDecryptedProfiles keeps the contact block and locations Signals returns', async () => {
    const row = {
      item_id: 'item-1',
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      item_state: {},
      contact: {
        name: { value: 'Asha', source: 'item' },
        phone: { value: null, source: null },
      },
      locations: [{ lat: 12.9, lng: 77.6 }],
      created_at: '2026-06-26T12:03:04.686Z',
      updated_at: '2026-06-26T12:03:04.686Z',
    };
    fetchMock.mockResolvedValueOnce(okJsonResponse({ profiles: [row], skipped: [] }));

    const result = await writer.fetchDecryptedProfiles({
      actingOrgId: 'org-abc',
      itemIds: ['item-1'],
      contact: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({ profiles: [row], skipped: [] });
  });

  it('fetchDecryptedProfiles rejects a row whose item_state is not an object, without its values', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        profiles: [
          {
            item_id: 'item-1',
            item_network: 'blue_dot',
            item_domain: 'seeker',
            item_type: 'profile_1.0',
            item_state: PARTICIPANT_PHONE,
            created_at: '2026-06-26T12:03:04.686Z',
            updated_at: '2026-06-26T12:03:04.686Z',
          },
        ],
        skipped: [],
      }),
    );

    const result = await writer.fetchDecryptedProfiles({
      actingOrgId: 'org-abc',
      itemIds: ['item-1'],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
    expect(result.error.details).toEqual({
      issues: [{ path: 'profiles.0.item_state', code: 'invalid_type' }],
    });
    expect(JSON.stringify(result.error.toJSON())).not.toContain(PARTICIPANT_PHONE);
  });
});

// ---------------------------------------------------------------------------
// Bodies that must not reach an error, and onboard item selection
// ---------------------------------------------------------------------------

describe('HttpSignalStackWriter — error bodies and onboard items', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  /** A participant value that must never reach an error. */
  const PARTICIPANT_PHONE = '+919800000002';

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      actingOrgId: 'platform-org-1',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });
  });

  const onboardInput = {
    actingOrgId: 'org-abc',
    name: 'Asha',
    phoneNumber: PARTICIPANT_PHONE,
    channel: 'bulk' as const,
    source_id: 'src-1',
    network: 'blue_dot',
    domain: 'seeker',
    item_type: 'profile_1.0',
    profile: { name: 'Asha' },
  };

  /** One call per JSON-reading operation, so each case runs against all of them. */
  const jsonOperations: Array<
    [string, (w: HttpSignalStackWriter) => Promise<{ success: boolean }>]
  > = [
    ['onboard', (w) => w.onboard(onboardInput)],
    [
      'aggregator upsert',
      (w) => w.upsertAggregator({ external_id: 'ext', name: 'Agg', slug: 'agg' }),
    ],
    ['dashboard', (w) => w.fetchDashboard({ actingOrgId: 'org-abc' })],
    ['decrypt', (w) => w.fetchDecryptedProfiles({ actingOrgId: 'org-abc', itemIds: ['item-1'] })],
    [
      'probe',
      (w) =>
        w.probeUser({
          actingOrgId: 'org-abc',
          phoneNumber: PARTICIPANT_PHONE,
          network: 'blue_dot',
          domain: 'seeker',
        }),
    ],
  ];

  it.each(jsonOperations)(
    '%s: a 2xx body that is not JSON is SIGNALSTACK_BAD_RESPONSE without the body text',
    async (operation, call) => {
      const bodyText = `<html>proxy error for ${PARTICIPANT_PHONE}</html>`;
      fetchMock.mockResolvedValueOnce(new Response(bodyText, { status: 200 }));

      const result = await call(writer);

      expect(result.success).toBe(false);
      if (result.success || !('error' in result) || !(result.error instanceof Error)) return;
      const error = result.error as unknown as { code: string; toJSON(): unknown };
      expect(error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
      expect((result.error as Error).message).toContain(operation);
      expect(JSON.stringify(error.toJSON())).not.toContain(PARTICIPANT_PHONE);
    },
  );

  it.each(jsonOperations)(
    '%s: a non-2xx error does not carry the raw Signals body',
    async (_operation, call) => {
      fetchMock.mockResolvedValueOnce(
        errJsonResponse(400, {
          error: 'INVALID_ITEM_STATE',
          message: 'bad',
          echo: PARTICIPANT_PHONE,
        }),
      );

      const result = await call(writer);

      expect(result.success).toBe(false);
      if (result.success || !('error' in result)) return;
      const details = (result.error as { details?: Record<string, unknown> }).details;
      expect(details?.status).toBe(400);
      expect(details).not.toHaveProperty('body');
      expect(JSON.stringify(details)).not.toContain(PARTICIPANT_PHONE);
    },
  );

  it('onboard keeps the fields the worker reads on a non-2xx error', async () => {
    fetchMock.mockResolvedValueOnce(
      errJsonResponse(400, {
        error: 'INVALID_ITEM_STATE',
        message: 'Invalid item_state',
        fields: { phone: 'must be E.164' },
      }),
    );

    const result = await writer.onboard(onboardInput);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.details).toEqual({
      status: 400,
      signalsMessage: 'Invalid item_state',
      upstreamCode: 'INVALID_ITEM_STATE',
      signalsFields: { phone: 'must be E.164' },
    });
  });

  it('a non-Error AbortError thrown by fetch maps to SIGNALSTACK_TIMEOUT', async () => {
    fetchMock.mockRejectedValueOnce({ name: 'AbortError', message: 'aborted' });

    const result = await writer.fetchDashboard({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TIMEOUT');
  });

  it('onboard ignores a malformed item that is not the one for the request', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'user-1',
        items: [
          { item_id: 7, item_network: null, item_state: 'not-an-object' },
          {
            item_id: 'item-ok',
            item_network: 'blue_dot',
            item_domain: 'seeker',
            item_type: 'profile_1.0',
            lifecycle_status: 'live',
          },
        ],
      }),
    );

    const result = await writer.onboard(onboardInput);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.profile_item_id).toBe('item-ok');
    expect(result.value.lifecycle_status).toBe('live');
  });

  it('onboard ignores extra and unknown fields on the chosen item', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'user-1',
        items: [
          {
            item_id: 'item-ok',
            item_network: 'blue_dot',
            item_domain: 'seeker',
            item_type: 'profile_1.0',
            item_state: { phone: PARTICIPANT_PHONE },
            future_field: { nested: [1, 2] },
          },
        ],
      }),
    );

    const result = await writer.onboard(onboardInput);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.profile_item_id).toBe('item-ok');
  });

  it('onboard reports the path of a malformed chosen item, without its values', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'user-1',
        items: [
          { item_id: 'other', item_network: 'purple_dot', item_domain: 'seeker', item_type: 'x' },
          {
            item_id: 42,
            item_network: 'blue_dot',
            item_domain: 'seeker',
            item_type: 'profile_1.0',
            item_state: { phone: PARTICIPANT_PHONE },
          },
        ],
      }),
    );

    const result = await writer.onboard(onboardInput);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
    expect(result.error.details).toEqual({
      issues: [{ path: 'items.1.item_id', code: 'invalid_type' }],
    });
    expect(JSON.stringify(result.error.toJSON())).not.toContain(PARTICIPANT_PHONE);
  });

  it('keeps at most 10 issues for one bad response', async () => {
    const badRow = { item_id: 1, item_state: {} };
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({ profiles: Array.from({ length: 15 }, () => badRow), skipped: [] }),
    );

    const result = await writer.fetchDecryptedProfiles({ actingOrgId: 'org-abc', itemIds: ['i'] });

    expect(result.success).toBe(false);
    if (result.success) return;
    const issues = (result.error.details as { issues: unknown[] }).issues;
    expect(issues).toHaveLength(10);
  });

  it('a bad-response message never contains a received value', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        profiles: [
          {
            item_id: 'item-1',
            item_network: 'blue_dot',
            item_domain: 'seeker',
            item_type: 'profile_1.0',
            item_state: {},
            contact: { phone: { value: PARTICIPANT_PHONE, source: PARTICIPANT_PHONE } },
            created_at: '2026-06-26T12:03:04.686Z',
            updated_at: '2026-06-26T12:03:04.686Z',
          },
        ],
        skipped: [],
      }),
    );

    const result = await writer.fetchDecryptedProfiles({ actingOrgId: 'org-abc', itemIds: ['i'] });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain('profiles.0.contact.phone.source');
    expect(result.error.message).not.toContain(PARTICIPANT_PHONE);
    expect(JSON.stringify(result.error.toJSON())).not.toContain(PARTICIPANT_PHONE);
  });

  it('probeUser treats a user_id of "" as a new user', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ user_id: '', compliance: [], items: [] }));

    const result = await writer.probeUser({
      actingOrgId: 'org-abc',
      email: 'asha@example.com',
      network: 'blue_dot',
      domain: 'seeker',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({
      user_exists: false,
      owned_elsewhere: false,
      lifecycle_summary: null,
    });
  });
});

describe('HttpSignalStackWriter.exportDashboardCsv — error body', () => {
  it('a non-2xx error does not carry the raw Signals body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(errTextResponse(400, 'echo +919800000003'));
    const writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    const result = await writer.exportDashboardCsv({ actingOrgId: 'org-abc' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.details).toEqual({ status: 400 });
  });
});

describe('HttpSignalStackWriter — non-JSON error bodies and probe items', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  /** A participant value that must never reach an error. */
  const PARTICIPANT_PHONE = '+919800000004';

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      actingOrgId: 'platform-org-1',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });
  });

  const calls: Array<[string, (w: HttpSignalStackWriter) => Promise<unknown>]> = [
    [
      'onboard',
      (w) =>
        w.onboard({
          actingOrgId: 'org-abc',
          name: 'Asha',
          phoneNumber: PARTICIPANT_PHONE,
          channel: 'bulk',
          source_id: 'src-1',
          network: 'blue_dot',
          domain: 'seeker',
          item_type: 'profile_1.0',
          profile: { name: 'Asha' },
        }),
    ],
    ['aggregator upsert', (w) => w.upsertAggregator({ external_id: 'e', name: 'n', slug: 's' })],
    ['dashboard', (w) => w.fetchDashboard({ actingOrgId: 'org-abc' })],
    ['dashboard export', (w) => w.exportDashboardCsv({ actingOrgId: 'org-abc' })],
    ['decrypt', (w) => w.fetchDecryptedProfiles({ actingOrgId: 'org-abc', itemIds: ['i'] })],
    [
      'probe',
      (w) =>
        w.probeUser({
          actingOrgId: 'org-abc',
          phoneNumber: PARTICIPANT_PHONE,
          network: 'blue_dot',
          domain: 'seeker',
        }),
    ],
  ];

  it.each(calls)(
    '%s: a non-JSON error body is not copied into the message',
    async (operation, call) => {
      fetchMock.mockResolvedValueOnce(
        errTextResponse(502, `<html>bad gateway for ${PARTICIPANT_PHONE}</html>`),
      );

      const result = (await call(writer)) as { success: boolean; error?: Error };

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe(`signalstack ${operation} returned 502`);
    },
  );

  it('probeUser ignores a malformed item that is not the one for the probed domain', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        user_id: 'user-1',
        compliance: [],
        items: [
          { item_id: 9, item_domain: null, item_state: 'x' },
          {
            item_id: 'item-ok',
            item_network: 'blue_dot',
            item_domain: 'seeker',
            lifecycle_status: 'draft',
          },
        ],
      }),
    );

    const result = await writer.probeUser({
      actingOrgId: 'org-abc',
      email: 'asha@example.com',
      network: 'blue_dot',
      domain: 'seeker',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.lifecycle_summary).toEqual({
      primary_item: { item_id: 'item-ok', lifecycle_status: 'draft' },
    });
  });
});
