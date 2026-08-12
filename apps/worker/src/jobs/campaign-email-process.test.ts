import { describe, it, expect, vi, beforeEach } from 'vitest';

// The processor is pure wiring: resolve collaborators, then delegate to
// runEmailSend. Mock runEmailSend + the collaborators so we assert the wiring.
const { runEmailSendMock, getSignalStackWriterMock, getMailerMock, errorMock } = vi.hoisted(() => ({
  runEmailSendMock: vi.fn(),
  getSignalStackWriterMock: vi.fn(),
  getMailerMock: vi.fn(() => ({ send: vi.fn() })),
  errorMock: vi.fn(),
}));

vi.mock('../services/campaign-email/index.js', () => ({ runEmailSend: runEmailSendMock }));
vi.mock('../services/signalstack.js', () => ({ getSignalStackWriter: getSignalStackWriterMock }));
vi.mock('@aggregator-dpg/mailer', () => ({ getMailer: getMailerMock }));
vi.mock('../config.js', () => ({ config: { EMAIL_SEND_CONCURRENCY: 5 } }));
vi.mock('../logger.js', () => ({
  logger: { child: () => ({ error: errorMock, info: vi.fn(), warn: vi.fn() }) },
}));

import { processCampaignEmail } from './campaign-email-process.js';

describe('processCampaignEmail', () => {
  beforeEach(() => {
    runEmailSendMock.mockReset().mockResolvedValue(undefined);
    getSignalStackWriterMock.mockReset();
    errorMock.mockReset();
  });

  it('runs the send with the payload + resolved deps when Signals is configured', async () => {
    const ss = { fetchDecryptedProfiles: vi.fn() };
    getSignalStackWriterMock.mockReturnValue(ss);

    await processCampaignEmail({
      orgId: 'org-1',
      itemIds: ['a', 'b'],
      subject: 'Hi',
      bodyMarkdown: 'Body',
      replyTo: 'r@x.com',
      purpose: 'audit',
      requestId: 'req-9',
    });

    expect(runEmailSendMock).toHaveBeenCalledTimes(1);
    const [params, deps] = runEmailSendMock.mock.calls[0]!;
    expect(params).toEqual({
      orgId: 'org-1',
      itemIds: ['a', 'b'],
      subject: 'Hi',
      bodyMarkdown: 'Body',
      replyTo: 'r@x.com',
      purpose: 'audit',
      requestId: 'req-9',
    });
    expect(deps.concurrency).toBe(5);
    deps.fetchDecryptedProfiles({ actingOrgId: 'org-1', itemIds: ['a'] });
    expect(ss.fetchDecryptedProfiles).toHaveBeenCalled();
    expect(typeof deps.sendMail).toBe('function');
  });

  it('omits optional fields from the params when absent', async () => {
    getSignalStackWriterMock.mockReturnValue({ fetchDecryptedProfiles: vi.fn() });
    await processCampaignEmail({ orgId: 'org-1', itemIds: ['a'], subject: 'S', bodyMarkdown: 'B' });
    expect(runEmailSendMock.mock.calls[0]![0]).toEqual({
      orgId: 'org-1',
      itemIds: ['a'],
      subject: 'S',
      bodyMarkdown: 'B',
    });
  });

  it('logs a terminal failure and does NOT run the send when Signals is unconfigured', async () => {
    getSignalStackWriterMock.mockReturnValue(null);
    await processCampaignEmail({ orgId: 'org-1', itemIds: ['a'], subject: 'S', bodyMarkdown: 'B' });
    expect(runEmailSendMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(errorMock.mock.calls[0]![0]).toMatchObject({
      status: 'failure',
      reason: 'signalstack_not_configured',
    });
  });
});
