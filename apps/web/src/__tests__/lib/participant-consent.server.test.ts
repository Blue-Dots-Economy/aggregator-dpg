import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const readFileMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  default: { readFile: readFileMock },
}));

const existsSyncMock = vi.fn();
vi.mock('node:fs', () => ({ existsSync: existsSyncMock, default: { existsSync: existsSyncMock } }));

vi.mock('@/lib/config-paths', () => ({ resolveSchemaRoot: () => '/config/schemas' }));

// Silence structured logging in the URL-fetch paths.
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { loadParticipantConsent, normalizeConsentUrl } =
  await import('@/lib/participant-consent.server');

function validFile(overrides: Record<string, unknown> = {}) {
  return {
    documents: {
      terms: {
        current_version: 2,
        versions: [
          { version: 1, title: 'Terms v1', content: 'old' },
          { version: 2, title: 'Terms v2', content: 'Contact us at __SUPPORT_EMAIL__' },
        ],
      },
      privacy: {
        current_version: 1,
        versions: [{ version: 1, title: 'Privacy v1', content: 'privacy body' }],
      },
      ...overrides,
    },
  };
}

function jsonResponse(body: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('normalizeConsentUrl', () => {
  it('rewrites a GitHub blob URL to raw.githubusercontent.com', () => {
    expect(
      normalizeConsentUrl('https://github.com/Blue-Dots-Economy/bluedots-schemas/blob/main/x.json'),
    ).toBe('https://raw.githubusercontent.com/Blue-Dots-Economy/bluedots-schemas/main/x.json');
  });

  it('passes an already-raw URL through unchanged', () => {
    const raw = 'https://raw.githubusercontent.com/o/r/main/x.json';
    expect(normalizeConsentUrl(raw)).toBe(raw);
  });

  it('passes a non-GitHub URL through unchanged', () => {
    const url = 'https://example.org/consent.json';
    expect(normalizeConsentUrl(url)).toBe(url);
  });
});

describe('loadParticipantConsent', () => {
  beforeEach(() => {
    readFileMock.mockReset();
    existsSyncMock.mockReset();
    delete process.env.CONSENT_SUPPORT_EMAIL;
    delete process.env.PARTICIPANT_CONSENT_URL;
    // Default: no external URL source reachable — the aggregator-config lookup
    // fails, so every test below exercises the on-disk fallback unless it opts
    // into a URL source explicitly.
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env.CONSENT_SUPPORT_EMAIL;
    delete process.env.PARTICIPANT_CONSENT_URL;
    vi.restoreAllMocks();
  });

  it('returns null when no consent file exists on any candidate path', async () => {
    existsSyncMock.mockReturnValue(false);
    await expect(loadParticipantConsent()).resolves.toBeNull();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('loads terms + privacy at their current version, rendering __SUPPORT_EMAIL__', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(JSON.stringify(validFile()));
    const result = await loadParticipantConsent();
    expect(result).not.toBeNull();
    expect(result!.terms).toEqual({
      version: 2,
      title: 'Terms v2',
      content: 'Contact us at hello@bluedotseconomy.org',
    });
    expect(result!.privacy).toEqual({ version: 1, title: 'Privacy v1', content: 'privacy body' });
    expect(result!.profileCreation).toBeUndefined();
  });

  it('renders CONSENT_SUPPORT_EMAIL when set', async () => {
    process.env.CONSENT_SUPPORT_EMAIL = 'support@example.org';
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(JSON.stringify(validFile()));
    const result = await loadParticipantConsent();
    expect(result!.terms.content).toBe('Contact us at support@example.org');
  });

  it('includes profileCreation when present', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(
      JSON.stringify(
        validFile({
          profile_creation: {
            current_version: 1,
            versions: [{ version: 1, statement: 'I consent, contact __SUPPORT_EMAIL__' }],
          },
        }),
      ),
    );
    const result = await loadParticipantConsent();
    expect(result!.profileCreation).toEqual({
      version: 1,
      statement: 'I consent, contact hello@bluedotseconomy.org',
    });
  });

  it('falls back to the first version when current_version does not match any entry', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        documents: {
          terms: { current_version: 99, versions: [{ version: 1, title: 'T', content: 'c' }] },
          privacy: { current_version: 1, versions: [{ version: 1, title: 'P', content: 'p' }] },
        },
      }),
    );
    const result = await loadParticipantConsent();
    expect(result!.terms).toEqual({ version: 1, title: 'T', content: 'c' });
  });

  it('returns null when terms or privacy have no versions', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(
      JSON.stringify({ documents: { terms: { current_version: 1, versions: [] } } }),
    );
    await expect(loadParticipantConsent()).resolves.toBeNull();
  });

  it('returns null when the file is malformed JSON', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue('{not-json');
    await expect(loadParticipantConsent()).resolves.toBeNull();
  });

  it('returns null when readFile throws', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockRejectedValue(new Error('EACCES'));
    await expect(loadParticipantConsent()).resolves.toBeNull();
  });

  describe('external URL source', () => {
    it('fetches consent from the brand participant_consent_url, normalizing a blob URL', async () => {
      const blob = 'https://github.com/o/r/blob/main/agg-config-source.json';
      const raw = 'https://raw.githubusercontent.com/o/r/main/agg-config-source.json';
      existsSyncMock.mockReturnValue(false); // prove it came from the URL, not disk
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/v1/aggregator-config')) {
          return jsonResponse({ brand: { participant_consent_url: blob } });
        }
        return jsonResponse(validFile());
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await loadParticipantConsent();
      expect(result!.terms.title).toBe('Terms v2');
      expect(readFileMock).not.toHaveBeenCalled();
      const fetchedUrls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(fetchedUrls).toContain(raw);
    });

    it('PARTICIPANT_CONSENT_URL env overrides brand config (no aggregator-config call)', async () => {
      process.env.PARTICIPANT_CONSENT_URL = 'https://example.org/env-override.json';
      existsSyncMock.mockReturnValue(false);
      const fetchMock = vi.fn(async () => jsonResponse(validFile()));
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await loadParticipantConsent();
      expect(result!.terms.title).toBe('Terms v2');
      const fetchedUrls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(fetchedUrls).toEqual(['https://example.org/env-override.json']);
      expect(fetchedUrls.some((u) => u.includes('/v1/aggregator-config'))).toBe(false);
    });

    it('falls back to the on-disk copy when the URL fetch fails', async () => {
      process.env.PARTICIPANT_CONSENT_URL = 'https://example.org/unreachable.json';
      existsSyncMock.mockReturnValue(true);
      readFileMock.mockResolvedValue(JSON.stringify(validFile()));
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(null, { ok: false, status: 500 }),
        ) as unknown as typeof fetch;

      const result = await loadParticipantConsent();
      expect(result!.terms.title).toBe('Terms v2');
      expect(readFileMock).toHaveBeenCalled();
    });

    it('caches a successful URL fetch across calls', async () => {
      process.env.PARTICIPANT_CONSENT_URL = 'https://example.org/cached-source.json';
      existsSyncMock.mockReturnValue(false);
      const fetchMock = vi.fn(async () => jsonResponse(validFile()));
      global.fetch = fetchMock as unknown as typeof fetch;

      await loadParticipantConsent();
      await loadParticipantConsent();
      const docCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('cached-source.json'),
      );
      expect(docCalls).toHaveLength(1);
    });
  });
});
