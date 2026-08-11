import { describe, it, expect, vi, beforeEach } from 'vitest';

// The processor is pure wiring: resolve collaborators, then delegate to
// runExport. Mock runExport + the collaborators so we assert the wiring only.
const { runExportMock, getSignalStackWriterMock, getMailerMock, errorMock } = vi.hoisted(() => ({
  runExportMock: vi.fn(),
  getSignalStackWriterMock: vi.fn(),
  getMailerMock: vi.fn(() => ({ send: vi.fn() })),
  errorMock: vi.fn(),
}));

vi.mock('../services/campaign-export/index.js', () => ({ runExport: runExportMock }));
vi.mock('../services/signalstack.js', () => ({ getSignalStackWriter: getSignalStackWriterMock }));
vi.mock('@aggregator-dpg/mailer', () => ({ getMailer: getMailerMock }));
vi.mock('../object-storage.js', () => ({ putObject: vi.fn(), signExportDownloadUrl: vi.fn() }));
vi.mock('../logger.js', () => ({
  logger: { child: () => ({ error: errorMock, info: vi.fn(), warn: vi.fn() }) },
}));

import { processCampaignExport } from './campaign-export-process.js';

describe('processCampaignExport', () => {
  beforeEach(() => {
    runExportMock.mockReset().mockResolvedValue(undefined);
    getSignalStackWriterMock.mockReset();
    errorMock.mockReset();
  });

  it('runs the export with the payload + resolved deps when Signals is configured', async () => {
    const ss = { fetchDecryptedProfiles: vi.fn() };
    getSignalStackWriterMock.mockReturnValue(ss);

    await processCampaignExport({
      orgId: 'org-1',
      itemIds: ['a', 'b'],
      recipientEmail: 'agg@org.example',
      purpose: 'audit',
      requestId: 'req-9',
    });

    expect(runExportMock).toHaveBeenCalledTimes(1);
    const [params, deps] = runExportMock.mock.calls[0]!;
    expect(params).toEqual({
      orgId: 'org-1',
      itemIds: ['a', 'b'],
      purpose: 'audit',
      requestId: 'req-9',
    });
    expect(deps.recipientEmail).toBe('agg@org.example');
    // decrypt is wired to the resolved Signals writer
    deps.fetchDecryptedProfiles({ actingOrgId: 'org-1', itemIds: ['a'] });
    expect(ss.fetchDecryptedProfiles).toHaveBeenCalled();
    expect(typeof deps.putObject).toBe('function');
    expect(typeof deps.signDownloadUrl).toBe('function');
    expect(typeof deps.sendMail).toBe('function');
  });

  it('omits purpose/requestId from the params when they are absent', async () => {
    getSignalStackWriterMock.mockReturnValue({ fetchDecryptedProfiles: vi.fn() });
    await processCampaignExport({
      orgId: 'org-1',
      itemIds: ['a'],
      recipientEmail: 'agg@org.example',
    });
    expect(runExportMock.mock.calls[0]![0]).toEqual({ orgId: 'org-1', itemIds: ['a'] });
  });

  it('logs a terminal failure and does NOT run the export when Signals is unconfigured', async () => {
    getSignalStackWriterMock.mockReturnValue(null);
    await processCampaignExport({
      orgId: 'org-1',
      itemIds: ['a'],
      recipientEmail: 'agg@org.example',
    });
    expect(runExportMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(errorMock.mock.calls[0]![0]).toMatchObject({
      status: 'failure',
      reason: 'signalstack_not_configured',
    });
  });
});
