/**
 * BFF route test: POST /api/consent (terms accepted at login).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));
const { storeTermsStatus } = vi.hoisted(() => ({ storeTermsStatus: vi.fn(async () => {}) }));
vi.mock('@/lib/terms-guard.server', () => ({ storeTermsStatus }));

import { POST } from '@/app/api/consent/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://portal.test/api/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://portal.test', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const versions = { terms_version: 3, privacy_version: 2 };

describe('POST /api/consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PUBLIC_PORTAL_URL;
  });

  it('refuses a cross-site request with 403 and does not call the API', async () => {
    const res = await POST(req(versions, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it('forwards the versions, passes the 200 through and stores ok in the session', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { recorded: 1 }));
    const res = await POST(req(versions));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: 1 });
    expect(mockCallApi).toHaveBeenCalledWith('/v1/user/consent', {
      method: 'POST',
      body: versions,
    });
    expect(storeTermsStatus).toHaveBeenCalledWith('ok');
  });

  it('passes a 409 through and leaves the session outstanding', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(409, { code: 'CONSENT_VERSION_CHANGED' }));
    const res = await POST(req(versions));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'CONSENT_VERSION_CHANGED' });
    expect(storeTermsStatus).not.toHaveBeenCalled();
  });

  it('passes another failure through without storing', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(403, { code: 'ACCOUNT_DISABLED' }));
    const res = await POST(req(versions));
    expect(res.status).toBe(403);
    expect(storeTermsStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['missing versions', {}],
    ['a string version', { terms_version: '3', privacy_version: 2 }],
    ['a non-integer version', { terms_version: 1.5, privacy_version: 2 }],
    ['an extra field', { ...versions, source: 'registration' }],
  ])('returns 400 for %s', async (_label, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await POST(req('not json'));
    expect(res.status).toBe(400);
  });

  it('returns 401 when there is no session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await POST(req(versions));
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await POST(req(versions));
    expect(res.status).toBe(503);
  });
});
