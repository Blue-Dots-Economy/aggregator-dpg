/**
 * Unit tests for the campaign-process job wiring — builds the real
 * collaborators and delegates to `runCampaignJob`.
 *
 * @module @aggregator-dpg/worker
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeObjectStorage } from '@aggregator-dpg/object-storage/testing';
import { _setObjectStorage } from '@aggregator-dpg/object-storage';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';

const runCampaignJobMock = vi.fn();
const getWriterMock = vi.fn();
const sendMock = vi.fn();

vi.mock('../services/campaign-process/index.js', () => ({ runCampaignJob: runCampaignJobMock }));
vi.mock('../services/signalstack.js', () => ({ getSignalStackWriter: getWriterMock }));
vi.mock('@aggregator-dpg/mailer', () => ({ getMailer: () => ({ send: sendMock }) }));
vi.mock('../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../config.js', () => ({
  config: {
    CAMPAIGN_DECRYPT_CHUNK: 500,
    CAMPAIGN_EXPORT_FIELDS: 'contact',
    CAMPAIGN_EXPORT_RECIPIENT: 'network_admin',
    EXPORT_NETWORK_ADMIN_EMAIL: 'admin@network.example',
    EXPORT_URL_TTL_SECONDS: 900,
  },
}));

const { processCampaignJob } = await import('./campaign-process.js');

describe('processCampaignJob', () => {
  const fake = new FakeObjectStorage();
  beforeEach(() => _setObjectStorage(fake));
  afterEach(() => vi.clearAllMocks());

  async function exportCollaborators() {
    getWriterMock.mockReturnValue({ fetchDecryptedProfiles: vi.fn() });
    runCampaignJobMock.mockResolvedValue(undefined);
    await processCampaignJob({ jobId: 'job-1' });
    return runCampaignJobMock.mock.calls[0]![1].export;
  }

  it('writes the export under campaign-exports and signs a download link', async () => {
    const exp = await exportCollaborators();
    const putSpy = vi.spyOn(fake, 'put');
    await exp.putObject('campaign-exports/org-1/job-1.csv', Buffer.from('a,b'), 'text/csv');
    expect(putSpy).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'text/csv' }));
    expect(fake.read({ area: 'exports', key: 'org-1/job-1.csv' })?.toString('utf8')).toBe('a,b');
    const signed = await exp.signDownloadUrl('campaign-exports/org-1/job-1.csv');
    expect(signed.url).toContain('campaign-exports/org-1/job-1.csv');
    expect(signed.url).toContain('participant-export.csv');
    expect(Math.abs(Date.parse(signed.expiresAt) - (Date.now() + 900_000))).toBeLessThan(5_000);
  });

  it('throws when the export write or signing fails so the job retries', async () => {
    const exp = await exportCollaborators();
    fake.failNext('put', new UpstreamError('storage down'));
    await expect(
      exp.putObject('campaign-exports/org-1/job-1.csv', Buffer.from('x'), 'text/csv'),
    ).rejects.toThrow('storage down');
    fake.failNext('createDownloadUrl', new UpstreamError('sign down'));
    await expect(exp.signDownloadUrl('campaign-exports/org-1/job-1.csv')).rejects.toThrow(
      'sign down',
    );
  });

  it('throws on an export key outside the exports area', async () => {
    const exp = await exportCollaborators();
    await expect(exp.signDownloadUrl('other/x.csv')).rejects.toThrow('not a valid exports key');
  });

  it('throws when the signalstack client is not configured', async () => {
    getWriterMock.mockReturnValue(null);
    await expect(processCampaignJob({ jobId: 'job-1' })).rejects.toThrow(/signalstack/i);
    expect(runCampaignJobMock).not.toHaveBeenCalled();
  });

  it('delegates to runCampaignJob with the client, collaborators, and config', async () => {
    getWriterMock.mockReturnValue({ fetchDecryptedProfiles: vi.fn() });
    runCampaignJobMock.mockResolvedValue(undefined);

    await processCampaignJob({ jobId: 'job-1' });

    expect(runCampaignJobMock).toHaveBeenCalledTimes(1);
    const [jobId, deps] = runCampaignJobMock.mock.calls[0]!;
    expect(jobId).toBe('job-1');
    expect(deps.config.decryptChunk).toBe(500);
    expect(deps.config.fieldSet).toBe('contact');
    expect(deps.config.recipientMode).toBe('network_admin');
    expect(deps.config.networkAdminEmail).toBe('admin@network.example');
    expect(typeof deps.export.fetchDecryptedProfiles).toBe('function');
    expect(typeof deps.client.getJobForProcessing).toBe('function');
    expect(typeof deps.voice.fetchDecryptedProfiles).toBe('function');
    // `provider` is a getter that defers to getVoiceProvider() — asserting the
    // descriptor exists (without invoking it) avoids tripping the
    // RAYA_API_KEY ConfigError this mocked config doesn't carry.
    expect(Object.getOwnPropertyDescriptor(deps.voice, 'provider')?.get).toBeInstanceOf(Function);
  });
});
