/**
 * Unit tests for {@link RayaVoiceProvider} — the Raya HTTP adapter for the
 * campaign voice channel (aggregator-dpg#577).
 *
 * Every test stubs `fetchImpl` (typed as `typeof fetch`) and `acquireSlot`
 * so no real network call or Redis egress gate is exercised. The 429-retry
 * tests inject a fake `sleep` so the suite stays fast and can assert the
 * exact computed wait deterministically, without needing fake timers.
 *
 * @module @aggregator-dpg/voice-provider
 */
import { describe, it, expect, vi } from 'vitest';
import { RayaVoiceProvider } from '../raya.js';
import type { VoiceDispatchInput } from '../interface.js';

const CREATE_OK_BODY = {
  status: 'success',
  batchId: 42,
  totalRows: 1,
  validRows: 1,
  invalidRows: 0,
  contactsInserted: 1,
};

const START_OK_BODY = { id: 42, status: 'Active', total_contacts: 1 };

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function baseInput(overrides: Partial<VoiceDispatchInput> = {}): VoiceDispatchInput {
  return {
    agentRef: 'agent-1',
    batchName: 'batch-1',
    contacts: [
      {
        ref: 'i1',
        name: 'Asha',
        phone: '9000000001',
        variables: { role: 'Electrician', employer: 'Acme' },
      },
    ],
    startOptions: { max_concurrent_calls: 5 },
    ...overrides,
  };
}

describe('RayaVoiceProvider', () => {
  it('creates then starts a batch, acquiring a slot before each call', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));
    const acquireSlot = vi.fn().mockResolvedValue(undefined);

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(acquireSlot).toHaveBeenCalledTimes(2);

    // create body carries contact_name/contact_phone/ref plus flattened variables.
    const [createUrl, createInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe('https://raya.example.com/api/batch');
    const createBody = JSON.parse(createInit.body as string);
    expect(createBody).toEqual({
      agent_id: 'agent-1',
      batch_name: 'batch-1',
      contacts: [
        {
          contact_name: 'Asha',
          contact_phone: '9000000001',
          ref: 'i1',
          role: 'Electrician',
          employer: 'Acme',
        },
      ],
    });
    expect(new Headers(createInit.headers).get('x-api-key')).toBe('key-abc');

    // start body forwards only the supplied startOptions keys, verbatim.
    const [startUrl, startInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(startUrl).toBe('https://raya.example.com/api/batch/42/start');
    expect(JSON.parse(startInit.body as string)).toEqual({ max_concurrent_calls: 5 });

    expect(result).toEqual({
      success: true,
      value: {
        providerBatchRef: '42',
        accepted: ['i1'],
        rejected: [],
        providerResponse: { create: CREATE_OK_BODY, start: START_OK_BODY },
      },
    });
  });

  it('injects no defaults into the start body beyond the supplied startOptions keys', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.dispatch(baseInput({ startOptions: {} }));

    const [, startInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(startInit.body as string)).toEqual({});
  });

  it('maps a create-time row rejection to rejected and excludes it from accepted', async () => {
    const createWithError = {
      ...CREATE_OK_BODY,
      validRows: 0,
      invalidRows: 1,
      errors: [{ row: 1, field: 'contact_phone', value: 'bad', message: 'bad' }],
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, createWithError));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    // start is never called when nothing was accepted.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      value: {
        providerBatchRef: '42',
        accepted: [],
        rejected: [{ ref: 'i1', error: 'bad' }],
        providerResponse: { create: createWithError, start: null },
      },
    });
  });

  it("retries a 429 honouring the JSON body retry_after — Raya's actual RateLimitError/ConcurrencyLimitError shape, which carries no Retry-After header", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { error: 'RateLimitError', message: 'rate limited', retry_after: 20 }),
      )
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 3,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // 20s body retry_after → 20000ms wait, not the computed exponential backoff.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(20000);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.providerBatchRef).toBe('42');
  });

  it('falls back to the HTTP Retry-After header when the 429 body carries no retry_after', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { message: 'rate limited' }, { 'retry-after': '5' }))
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 3,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(result.success).toBe(true);
  });

  it('prefers the body retry_after over the Retry-After header when both are present', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { retry_after: 3 }, { 'retry-after': '99' }))
      .mockResolvedValueOnce(jsonResponse(200, CREATE_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, START_OK_BODY));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 3,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    await provider.dispatch(baseInput());

    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('maps a 401 to AuthError without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { message: 'bad key' }));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 3,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('AuthError');
  });

  it('maps a non-429 4xx to ValidationError without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(400, { message: 'bad request' }));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 3,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('ValidationError');
  });

  it('maps an exhausted-retry 5xx to UpstreamError', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { message: 'down' }))
      .mockResolvedValueOnce(jsonResponse(503, { message: 'down' }));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 2,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('UpstreamError');
  });

  it('maps an exhausted-retry network failure to UpstreamError', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'));

    const provider = new RayaVoiceProvider({
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      maxAttempts: 2,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.dispatch(baseInput());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('UpstreamError');
  });
});
