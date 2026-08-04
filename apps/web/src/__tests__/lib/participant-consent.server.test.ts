import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const readFileMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  default: { readFile: readFileMock },
}));

const existsSyncMock = vi.fn();
vi.mock('node:fs', () => ({ existsSync: existsSyncMock, default: { existsSync: existsSyncMock } }));

vi.mock('@/lib/config-paths', () => ({ resolveSchemaRoot: () => '/config/schemas' }));

const { loadParticipantConsent } = await import('@/lib/participant-consent.server');

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

describe('loadParticipantConsent', () => {
  beforeEach(() => {
    readFileMock.mockReset();
    existsSyncMock.mockReset();
    delete process.env.CONSENT_SUPPORT_EMAIL;
  });

  afterEach(() => {
    delete process.env.CONSENT_SUPPORT_EMAIL;
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
});
