import { describe, it, expect } from 'vitest';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import {
  deriveJobStatus,
  TERMINAL_ITEM_STATUSES,
  type ProcessingJob,
} from '../campaign-job-client.js';
import { runCampaignJob, type CampaignJobDeps } from './index.js';

function row(over: Partial<SignalStackDecryptedProfileRow> = {}): SignalStackDecryptedProfileRow {
  return {
    item_id: 'item-1',
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: {},
    contact: {
      name: { value: 'Asha', source: 'item' },
      email: { value: 'asha@example.com', source: 'user' },
      phone: { value: '+910000000000', source: 'item' },
    },
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function job(over: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: 'job-1',
    channel: 'export',
    status: 'queued',
    signalstackOrgId: 'org-1',
    metadata: [{ key: 'purpose', value: 'audit' }],
    content: {},
    requestedBy: 'user@org.example',
    requestId: null,
    items: [{ itemId: 'item-1', action: null, status: 'pending' }],
    ...over,
  };
}

interface Harness {
  deps: CampaignJobDeps;
  puts: Array<{ key: string; body: Buffer; contentType: string }>;
  mails: SendInput[];
  /** Participant-facing sends from the email channel (distinct from `mails`). */
  emails: SendInput[];
  itemMarks: Array<{ itemId: string; status: string; err?: string; ref?: string }>;
  heartbeats: () => number;
  jobStatuses: string[];
  logs: { info: object[]; warn: object[]; error: object[] };
}

/**
 * Collaborator overrides. The decrypt is shared by every channel, the export
 * group is passed through as-is, and `emailSendMail` overrides the email
 * channel's mailer without touching the export one.
 */
type CollabOverrides = Partial<
  CampaignJobDeps['export'] & { fetchDecryptedProfiles: CampaignJobDeps['fetchDecryptedProfiles'] }
> & { emailSendMail?: CampaignJobDeps['email']['sendMail'] };

function harness(
  theJob: ProcessingJob | null,
  over: CollabOverrides = {},
  config: Partial<CampaignJobDeps['config']> = {},
): Harness {
  const puts: Harness['puts'] = [];
  const mails: SendInput[] = [];
  const emails: SendInput[] = [];
  const itemMarks: Harness['itemMarks'] = [];
  const jobStatuses: string[] = [];
  const logs = { info: [] as object[], warn: [] as object[], error: [] as object[] };
  let heartbeats = 0;

  const { fetchDecryptedProfiles, emailSendMail, ...exportOver } = over;

  // In-memory item-status map for roll-up + forward-only marks.
  const itemStatus = new Map(
    (theJob?.items ?? []).map((i) => [
      i.itemId,
      { status: i.status as string, err: null as string | null },
    ]),
  );
  const TERMINAL: string[] = [...TERMINAL_ITEM_STATUSES];

  const deps: CampaignJobDeps = {
    client: {
      getJobForProcessing: async () => theJob,
      markItem: async (_jobId, itemId, status, reason, providerRef) => {
        itemMarks.push({
          itemId,
          status,
          ...(reason ? { err: reason } : {}),
          ...(providerRef ? { ref: providerRef } : {}),
        });
        const cur = itemStatus.get(itemId);
        if (cur && !TERMINAL.includes(cur.status)) {
          cur.status = status;
          cur.err = reason ?? null;
        }
      },
      heartbeat: async () => {
        heartbeats++;
      },
      setJobStatus: async (_jobId, status) => {
        jobStatuses.push(status);
        if (theJob) theJob.status = status;
      },
      rollUpStatus: async () => {
        const counts = {
          total: 0,
          pending: 0,
          resolved: 0,
          submitted: 0,
          sent: 0,
          skipped_not_owned: 0,
          skipped_no_contact: 0,
          duplicate_active: 0,
          failed: 0,
        };
        for (const v of itemStatus.values()) {
          counts.total++;
          counts[v.status as keyof typeof counts]++;
        }
        const status = deriveJobStatus(counts);
        jobStatuses.push(status);
        if (theJob) theJob.status = status;
        return status;
      },
    },
    fetchDecryptedProfiles:
      fetchDecryptedProfiles ?? (async () => ok({ profiles: [row()], skipped: [] })),
    export: {
      putObject: async (key, body, contentType) => {
        puts.push({ key, body, contentType });
      },
      signDownloadUrl: async (key) => ({
        url: `https://signed.example/${key}`,
        key,
        expiresAt: '2026-08-01T01:00:00.000Z',
      }),
      sendMail: async (input): Promise<MailerResult<SendOk>> => {
        mails.push(input);
        return { ok: true, value: { messageId: 'm-1' } };
      },
      ...exportOver,
    },
    email: {
      sendMail:
        emailSendMail ??
        (async (input): Promise<MailerResult<SendOk>> => {
          emails.push(input);
          return { ok: true, value: { messageId: `msg-${emails.length}` } };
        }),
    },
    config: {
      decryptChunk: 500,
      fieldSet: 'contact',
      recipientMode: 'requester',
      emailSendConcurrency: 5,
      ...config,
    },
    log: {
      info: (o) => logs.info.push(o),
      warn: (o) => logs.warn.push(o),
      error: (o) => logs.error.push(o),
    },
  };
  return {
    deps,
    puts,
    mails,
    emails,
    itemMarks,
    heartbeats: () => heartbeats,
    jobStatuses,
    logs,
  };
}

describe('runCampaignJob (export channel)', () => {
  it('resolves every item, uploads a CSV, emails the link, and rolls up to succeeded', async () => {
    const h = harness(job());
    await runCampaignJob('job-1', h.deps);

    expect(h.jobStatuses[0]).toBe('processing');
    expect(h.jobStatuses.at(-1)).toBe('completed');
    expect(h.itemMarks).toEqual([{ itemId: 'item-1', status: 'resolved' }]);
    expect(h.heartbeats()).toBeGreaterThanOrEqual(1);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.key).toMatch(/^campaign-exports\/org-1\/.*\.csv$/);
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0]!.to).toBe('user@org.example');
    expect(h.mails[0]!.text).toContain('01 Aug 2026, 01:00 UTC');
  });

  it('marks an unowned item skipped_not_owned and still completes the job', async () => {
    const h = harness(
      job({
        items: [
          { itemId: 'a', action: null, status: 'pending' },
          { itemId: 'b', action: null, status: 'pending' },
        ],
      }),
      {
        fetchDecryptedProfiles: async () =>
          ok({ profiles: [row({ item_id: 'a' })], skipped: ['b'] }),
      },
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.itemMarks).toContainEqual({ itemId: 'a', status: 'resolved' });
    expect(h.itemMarks).toContainEqual({
      itemId: 'b',
      status: 'skipped_not_owned',
      err: 'not_owned_by_org',
    });
    // A skip is not a failure, so the job completes rather than going partial.
    expect(h.jobStatuses.at(-1)).toBe('completed');
    expect(h.mails).toHaveLength(1); // the one owned record is still exported
  });

  it('completes with no email when every item is unowned (all skipped)', async () => {
    const h = harness(job({ items: [{ itemId: 'a', action: null, status: 'pending' }] }), {
      fetchDecryptedProfiles: async () => ok({ profiles: [], skipped: ['a'] }),
    });
    await runCampaignJob('job-1', h.deps);
    // Nothing was owned, so nothing was exported — but the handler ran
    // correctly, so this is `completed` with counts telling the real story,
    // not `failed`. See deriveJobStatus.
    expect(h.jobStatuses.at(-1)).toBe('completed');
    expect(h.itemMarks).toContainEqual({
      itemId: 'a',
      status: 'skipped_not_owned',
      err: 'not_owned_by_org',
    });
    expect(h.puts).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
  });

  it('throws (BullMQ retry) and leaves the job processing when decrypt fails', async () => {
    const h = harness(job(), {
      fetchDecryptedProfiles: async () => err(new UpstreamError('signals down', { code: 'X' })),
    });
    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/decrypt/);
    expect(h.jobStatuses).toEqual(['processing']); // never rolled up to terminal
    expect(h.mails).toHaveLength(0);
    expect(h.logs.error).toHaveLength(1);
  });

  it('throws when a contact projection returns no contact block (#521 guard)', async () => {
    const h = harness(job(), {
      fetchDecryptedProfiles: async () =>
        ok({
          profiles: [
            {
              item_id: 'item-1',
              item_network: 'blue_dot',
              item_domain: 'seeker',
              item_type: 'profile_1.0',
              item_state: {},
              created_at: '2026-08-01T00:00:00.000Z',
              updated_at: '2026-08-01T00:00:00.000Z',
            },
          ],
          skipped: [],
        }),
    });
    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/#521/);
    expect(h.mails).toHaveLength(0);
  });

  it('is a no-op for an already-terminal job (retry guard)', async () => {
    const h = harness(job({ status: 'completed' }));
    await runCampaignJob('job-1', h.deps);
    expect(h.jobStatuses).toEqual([]); // never set processing
    expect(h.puts).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
  });

  it('uses the variable-column CSV builder for the full field-set', async () => {
    const h = harness(
      job(),
      {
        fetchDecryptedProfiles: async () =>
          ok({ profiles: [row({ item_state: { age: '30' } })], skipped: [] }),
      },
      { fieldSet: 'full' },
    );
    await runCampaignJob('job-1', h.deps);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.body.toString('utf8')).toContain('age');
  });

  it('prefers the recipient override over the job requested_by', async () => {
    const h = harness(
      job(),
      {},
      { recipientMode: 'network_admin', networkAdminEmail: 'admin@network.example' },
    );
    await runCampaignJob('job-1', h.deps);
    expect(h.mails[0]!.to).toBe('admin@network.example');
  });

  it('never logs raw contact PII', async () => {
    const h = harness(job());
    await runCampaignJob('job-1', h.deps);
    const serialized = JSON.stringify([...h.logs.info, ...h.logs.warn, ...h.logs.error]);
    expect(serialized).not.toContain('Asha');
    expect(serialized).not.toContain('asha@example.com');
    expect(serialized).not.toContain('+910000000000');
  });
});

describe('runCampaignJob (email channel)', () => {
  const CONTENT = { subject: 'Hello {{first_name}}', body_markdown: 'Hi **{{name}}**, news.' };

  function emailJob(over: Partial<ProcessingJob> = {}): ProcessingJob {
    return job({ channel: 'email', content: { ...CONTENT }, ...over });
  }

  it('sends to every resolved recipient, records the message id, and completes', async () => {
    const h = harness(emailJob());
    await runCampaignJob('job-1', h.deps);

    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]!.to).toBe('asha@example.com');
    expect(h.emails[0]!.subject).toBe('Hello Asha');
    expect(h.emails[0]!.html).toContain('<strong>Asha</strong>');
    // `sent` carries the mailer's message id as the item's provider ref.
    expect(h.itemMarks).toEqual([{ itemId: 'item-1', status: 'sent', ref: 'msg-1' }]);
    expect(h.jobStatuses.at(-1)).toBe('completed');
    // Nothing from the export channel ran.
    expect(h.puts).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
  });

  it('passes Reply-To through from the job content when set', async () => {
    const h = harness(emailJob({ content: { ...CONTENT, reply_to: 'campaign@org.example' } }));
    await runCampaignJob('job-1', h.deps);
    expect(h.emails[0]!.replyTo).toBe('campaign@org.example');
  });

  it('only decrypts the contact fields the template references', async () => {
    const queries: unknown[] = [];
    const h = harness(emailJob({ content: { subject: 'Hi', body_markdown: 'No tokens' } }), {
      fetchDecryptedProfiles: async (q) => {
        queries.push(q);
        return ok({ profiles: [row()], skipped: [] });
      },
    });
    await runCampaignJob('job-1', h.deps);
    // No placeholders → only the address itself is needed.
    expect(queries[0]).toMatchObject({ fields: [], contact: ['email'] });
  });

  it('skips a recipient with no email address as skipped_no_contact, not failed', async () => {
    const h = harness(
      emailJob({
        items: [
          { itemId: 'a', action: null, status: 'pending' },
          { itemId: 'b', action: null, status: 'pending' },
        ],
      }),
      {
        fetchDecryptedProfiles: async () =>
          ok({
            profiles: [
              row({ item_id: 'a' }),
              row({
                item_id: 'b',
                contact: { name: { value: 'Ravi', source: 'item' } },
              }),
            ],
            skipped: [],
          }),
      },
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.emails).toHaveLength(1);
    expect(h.itemMarks).toContainEqual({ itemId: 'a', status: 'sent', ref: 'msg-1' });
    expect(h.itemMarks).toContainEqual({
      itemId: 'b',
      status: 'skipped_no_contact',
      err: 'no_email_address',
    });
    // A skip is not a failure — the job still completes.
    expect(h.jobStatuses.at(-1)).toBe('completed');
  });

  it('marks an unowned id skipped_not_owned without emailing it', async () => {
    const h = harness(
      emailJob({
        items: [
          { itemId: 'a', action: null, status: 'pending' },
          { itemId: 'b', action: null, status: 'pending' },
        ],
      }),
      {
        fetchDecryptedProfiles: async () =>
          ok({ profiles: [row({ item_id: 'a' })], skipped: ['b'] }),
      },
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.emails).toHaveLength(1);
    expect(h.itemMarks).toContainEqual({
      itemId: 'b',
      status: 'skipped_not_owned',
      err: 'not_owned_by_org',
    });
    expect(h.jobStatuses.at(-1)).toBe('completed');
  });

  it('records a per-recipient send failure as failed and rolls the job to partial', async () => {
    let call = 0;
    const h = harness(
      emailJob({
        items: [
          { itemId: 'a', action: null, status: 'pending' },
          { itemId: 'b', action: null, status: 'pending' },
        ],
      }),
      {
        fetchDecryptedProfiles: async () =>
          ok({ profiles: [row({ item_id: 'a' }), row({ item_id: 'b' })], skipped: [] }),
        emailSendMail: async (): Promise<MailerResult<SendOk>> => {
          call += 1;
          return call === 1
            ? { ok: true, value: { messageId: 'msg-1' } }
            : { ok: false, error: { code: 'TRANSPORT_FAILED', message: 'smtp refused' } };
        },
      },
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.itemMarks).toContainEqual({ itemId: 'a', status: 'sent', ref: 'msg-1' });
    expect(h.itemMarks).toContainEqual({
      itemId: 'b',
      status: 'failed',
      err: 'TRANSPORT_FAILED: smtp refused',
    });
    // One sent, one failed → partial (a mix), never a whole-job failure.
    expect(h.jobStatuses.at(-1)).toBe('partial');
  });

  it('never re-emails an item already sent when the job is retried', async () => {
    // Attempt 2 of the same job: `a` was sent last time (terminal), `b` was not.
    const h = harness(
      emailJob({
        status: 'processing',
        items: [
          { itemId: 'a', action: null, status: 'sent' },
          { itemId: 'b', action: null, status: 'pending' },
        ],
      }),
      {
        fetchDecryptedProfiles: async (q) =>
          // The retry must not even ask Signals about the already-sent item.
          ok({
            profiles: (q.itemIds ?? []).map((id) => row({ item_id: id })),
            skipped: [],
          }),
      },
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.emails).toHaveLength(1);
    expect(h.itemMarks.map((m) => m.itemId)).toEqual(['b']);
    expect(h.itemMarks).toContainEqual({ itemId: 'b', status: 'sent', ref: 'msg-1' });
  });

  it('emails nobody when every item is already terminal (full retry)', async () => {
    const h = harness(
      emailJob({
        status: 'processing',
        items: [{ itemId: 'a', action: null, status: 'sent' }],
      }),
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.emails).toHaveLength(0);
    expect(h.itemMarks).toHaveLength(0);
    expect(h.jobStatuses.at(-1)).toBe('completed');
  });

  it('fails the items (not the process) when the stored content is malformed', async () => {
    const h = harness(emailJob({ content: { subject: 'only a subject' } }));
    await runCampaignJob('job-1', h.deps);

    // Deterministic — a retry cannot fix it, so the job reaches a terminal
    // status instead of being left `processing` for the watchdog.
    expect(h.emails).toHaveLength(0);
    expect(h.itemMarks).toEqual([
      { itemId: 'item-1', status: 'failed', err: 'invalid_email_content' },
    ]);
    expect(h.jobStatuses.at(-1)).toBe('failed');
    expect(h.logs.error).toHaveLength(1);
  });

  it('throws (BullMQ retry) and leaves the job processing when decrypt fails', async () => {
    const h = harness(emailJob(), {
      fetchDecryptedProfiles: async () => err(new UpstreamError('signals down', { code: 'X' })),
    });
    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/email decrypt failed/);
    expect(h.jobStatuses).toEqual(['processing']);
    expect(h.emails).toHaveLength(0);
  });

  it('throws when a contact projection returns no contact block (#521 guard)', async () => {
    const h = harness(emailJob(), {
      fetchDecryptedProfiles: async () =>
        ok({
          profiles: [
            {
              item_id: 'item-1',
              item_network: 'blue_dot',
              item_domain: 'seeker',
              item_type: 'profile_1.0',
              item_state: {},
              created_at: '2026-08-01T00:00:00.000Z',
              updated_at: '2026-08-01T00:00:00.000Z',
            },
          ],
          skipped: [],
        }),
    });
    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/#521/);
    expect(h.emails).toHaveLength(0);
  });

  it('never logs the recipient address or other contact PII', async () => {
    const h = harness(emailJob());
    await runCampaignJob('job-1', h.deps);
    const serialized = JSON.stringify([...h.logs.info, ...h.logs.warn, ...h.logs.error]);
    expect(serialized).not.toContain('asha@example.com');
    expect(serialized).not.toContain('+910000000000');
    expect(serialized).not.toContain('Asha');
  });
});
