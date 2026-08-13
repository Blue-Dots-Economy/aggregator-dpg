import { describe, it, expect } from 'vitest';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import { deriveJobStatus, type ProcessingJob } from '../campaign-job-client.js';
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
    status: 'pending',
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
  itemMarks: Array<{ itemId: string; status: string; err?: string }>;
  heartbeats: () => number;
  jobStatuses: string[];
  logs: { info: object[]; warn: object[]; error: object[] };
}

function harness(
  theJob: ProcessingJob | null,
  over: Partial<CampaignJobDeps['export']> = {},
  config: Partial<CampaignJobDeps['config']> = {},
): Harness {
  const puts: Harness['puts'] = [];
  const mails: SendInput[] = [];
  const itemMarks: Harness['itemMarks'] = [];
  const jobStatuses: string[] = [];
  const logs = { info: [] as object[], warn: [] as object[], error: [] as object[] };
  let heartbeats = 0;

  // In-memory item-status map for roll-up + forward-only marks.
  const itemStatus = new Map(
    (theJob?.items ?? []).map((i) => [
      i.itemId,
      { status: i.status as string, err: null as string | null },
    ]),
  );
  const TERMINAL = ['resolved', 'submitted', 'failed'];

  const deps: CampaignJobDeps = {
    client: {
      getJobForProcessing: async () => theJob,
      markItem: async (_jobId, itemId, status, errorReason) => {
        itemMarks.push({ itemId, status, ...(errorReason ? { err: errorReason } : {}) });
        const cur = itemStatus.get(itemId);
        if (cur && !TERMINAL.includes(cur.status)) {
          cur.status = status;
          cur.err = errorReason ?? null;
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
        const counts = { total: 0, pending: 0, resolved: 0, submitted: 0, failed: 0 };
        for (const v of itemStatus.values()) {
          counts.total++;
          counts[v.status as 'pending' | 'resolved' | 'submitted' | 'failed']++;
        }
        const status = deriveJobStatus(counts);
        jobStatuses.push(status);
        if (theJob) theJob.status = status;
        return status;
      },
    },
    export: {
      fetchDecryptedProfiles: async () => ok({ profiles: [row()], skipped: [] }),
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
      ...over,
    },
    config: { decryptChunk: 500, fieldSet: 'contact', ...config },
    log: {
      info: (o) => logs.info.push(o),
      warn: (o) => logs.warn.push(o),
      error: (o) => logs.error.push(o),
    },
  };
  return { deps, puts, mails, itemMarks, heartbeats: () => heartbeats, jobStatuses, logs };
}

describe('runCampaignJob (export channel)', () => {
  it('resolves every item, uploads a CSV, emails the link, and rolls up to succeeded', async () => {
    const h = harness(job());
    await runCampaignJob('job-1', h.deps);

    expect(h.jobStatuses[0]).toBe('processing');
    expect(h.jobStatuses.at(-1)).toBe('succeeded');
    expect(h.itemMarks).toEqual([{ itemId: 'item-1', status: 'resolved' }]);
    expect(h.heartbeats()).toBeGreaterThanOrEqual(1);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.key).toMatch(/^campaign-exports\/org-1\/.*\.csv$/);
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0]!.to).toBe('user@org.example');
    expect(h.mails[0]!.text).toContain('01 Aug 2026, 01:00 UTC');
  });

  it('marks a skipped item failed and rolls up to partially_failed', async () => {
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
      status: 'failed',
      err: 'not_found_or_not_owned',
    });
    expect(h.jobStatuses.at(-1)).toBe('partially_failed');
    expect(h.mails).toHaveLength(1); // one record still exported
  });

  it('rolls up to failed and sends no email when nothing resolves', async () => {
    const h = harness(job({ items: [{ itemId: 'a', action: null, status: 'pending' }] }), {
      fetchDecryptedProfiles: async () => ok({ profiles: [], skipped: ['a'] }),
    });
    await runCampaignJob('job-1', h.deps);
    expect(h.jobStatuses.at(-1)).toBe('failed');
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
    const h = harness(job({ status: 'succeeded' }));
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
    const h = harness(job(), {}, { recipientOverride: 'admin@network.example' });
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
