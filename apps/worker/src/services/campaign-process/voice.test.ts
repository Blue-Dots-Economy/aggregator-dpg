import { describe, it, expect } from 'vitest';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type {
  SignalStackDecryptedProfileRow,
  SignalStackDecryptedProfiles,
  SignalStackFetchDecryptedProfilesQuery,
} from '@aggregator-dpg/signalstack-writer/interface';
import { InMemoryVoiceProvider } from '@aggregator-dpg/voice-provider/testing';
import { VoiceProviderBase } from '@aggregator-dpg/voice-provider/interface';
import type {
  VoiceDispatchInput,
  VoiceDispatchResult,
} from '@aggregator-dpg/voice-provider/interface';
import { deriveJobStatus, type ProcessingJob } from '../campaign-job-client.js';
import { runCampaignJob, type CampaignJobDeps } from './index.js';

/** Always fails the batch create call — exercises the retryable-throw path. */
class FailingVoiceProvider extends VoiceProviderBase {
  override async dispatch(
    _input: VoiceDispatchInput,
  ): Promise<Result<VoiceDispatchResult, BaseError>> {
    return err(new UpstreamError('raya down', { code: 'RAYA_DOWN' }));
  }
}

type FetchFn = (
  q: SignalStackFetchDecryptedProfilesQuery,
) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;

function row(over: Partial<SignalStackDecryptedProfileRow> = {}): SignalStackDecryptedProfileRow {
  return {
    item_id: 'item-1',
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: { role: 'Electrician', langs: ['hi', 'en'] },
    contact: {
      name: { value: 'Asha', source: 'item' },
      phone: { value: '+910000000001', source: 'item' },
    },
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function job(over: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: 'job-1',
    channel: 'voice',
    status: 'queued',
    signalstackOrgId: 'org-1',
    metadata: [],
    content: { agent_id: 'agent-1' },
    requestedBy: 'user@org.example',
    requestId: null,
    notifiedAt: null,
    items: [
      { itemId: 'item-1', action: 'voice', status: 'pending', rayaBatchId: null },
      { itemId: 'item-2', action: 'voice', status: 'pending', rayaBatchId: null },
    ],
    ...over,
  };
}

interface Harness {
  deps: CampaignJobDeps;
  itemMarks: Array<{ itemId: string; status: string; err?: string }>;
  submitted: Array<{ itemId: string; rayaBatchId: string; providerRef?: string }>;
  providerResponses: unknown[];
  fetchQueries: SignalStackFetchDecryptedProfilesQuery[];
  heartbeats: () => number;
  jobStatuses: string[];
  statusReasons: Array<string | undefined>;
  pendingFails: string[];
  provider: InMemoryVoiceProvider;
  logs: { info: object[]; warn: object[]; error: object[] };
}

function harness(
  theJob: ProcessingJob | null,
  opts: { fetchDecryptedProfiles?: FetchFn; provider?: VoiceProviderBase } = {},
  attempt?: CampaignJobDeps['attempt'],
): Harness {
  const itemMarks: Harness['itemMarks'] = [];
  const submitted: Harness['submitted'] = [];
  const providerResponses: unknown[] = [];
  const fetchQueries: SignalStackFetchDecryptedProfilesQuery[] = [];
  const jobStatuses: string[] = [];
  const statusReasons: Array<string | undefined> = [];
  const pendingFails: string[] = [];
  const logs = { info: [] as object[], warn: [] as object[], error: [] as object[] };
  let heartbeats = 0;
  const provider = new InMemoryVoiceProvider();

  // Same forward-only terminal set the real markItem/markSubmitted guard on.
  const TERMINAL_STATUSES = [
    'submitted',
    'sent',
    'skipped_not_owned',
    'skipped_no_contact',
    'duplicate_active',
    'failed',
  ];

  const itemStatus = new Map(
    (theJob?.items ?? []).map((i) => [
      i.itemId,
      { status: i.status as string, err: null as string | null },
    ]),
  );

  const defaultFetch: FetchFn = async (q) => {
    fetchQueries.push(q);
    return ok({ profiles: q.itemIds.map((id) => row({ item_id: id })), skipped: [] });
  };

  const deps: CampaignJobDeps = {
    client: {
      getJobForProcessing: async () => theJob,
      markItem: async (_jobId, itemId, status, errorReason) => {
        itemMarks.push({ itemId, status, ...(errorReason ? { err: errorReason } : {}) });
        const cur = itemStatus.get(itemId);
        if (cur && !TERMINAL_STATUSES.includes(cur.status)) {
          cur.status = status;
          cur.err = errorReason ?? null;
        }
      },
      heartbeat: async () => {
        heartbeats++;
      },
      setJobStatus: async (_jobId, status, errorReason) => {
        jobStatuses.push(status);
        statusReasons.push(errorReason);
        if (theJob) theJob.status = status;
      },
      setNotifiedAt: async () => undefined,
      failPendingItems: async (_jobId, reason) => {
        pendingFails.push(reason);
        for (const v of itemStatus.values()) {
          if (v.status === 'pending') {
            v.status = 'failed';
            v.err = reason;
          }
        }
      },
      markSubmitted: async (_jobId, itemId, args) => {
        submitted.push({
          itemId,
          rayaBatchId: args.rayaBatchId,
          ...(args.providerRef !== undefined ? { providerRef: args.providerRef } : {}),
        });
        const cur = itemStatus.get(itemId);
        if (cur && !TERMINAL_STATUSES.includes(cur.status)) {
          cur.status = 'submitted';
          cur.err = null;
        }
      },
      setProviderResponse: async (_jobId, response) => {
        providerResponses.push(response);
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
    export: {
      fetchDecryptedProfiles: async () => ok({ profiles: [], skipped: [] }),
      putObject: async () => undefined,
      signDownloadUrl: async () => ({ url: '', key: '', expiresAt: '' }),
      sendMail: async () => ({ ok: true, value: { messageId: 'm-1' } }),
    },
    voice: {
      fetchDecryptedProfiles: opts.fetchDecryptedProfiles ?? defaultFetch,
      provider: opts.provider ?? provider,
    },
    config: { decryptChunk: 500, fieldSet: 'contact', recipientMode: 'requester' },
    log: {
      info: (o) => logs.info.push(o),
      warn: (o) => logs.warn.push(o),
      error: (o) => logs.error.push(o),
    },
    ...(attempt ? { attempt } : {}),
  };

  return {
    deps,
    itemMarks,
    submitted,
    providerResponses,
    fetchQueries,
    heartbeats: () => heartbeats,
    jobStatuses,
    statusReasons,
    pendingFails,
    provider,
    logs,
  };
}

describe('runVoiceForJob (via runCampaignJob)', () => {
  it('requests contact name/phone plus the content.variables field projection', async () => {
    const h = harness(job({ content: { agent_id: 'agent-1', variables: ['role'] } }));
    await runCampaignJob('job-1', h.deps);

    expect(h.fetchQueries).toHaveLength(1);
    expect(h.fetchQueries[0]!.contact).toEqual(['name', 'phone']);
    expect(h.fetchQueries[0]!.fields).toEqual(['role']);
  });

  it('omits the fields key (full item_state) when content.variables is unset', async () => {
    const h = harness(job()); // default content: { agent_id: 'agent-1' } — no variables
    await runCampaignJob('job-1', h.deps);

    expect(h.fetchQueries).toHaveLength(1);
    expect(h.fetchQueries[0]).not.toHaveProperty('fields');
  });

  it('builds contacts with ref + flattened, JSON-stringified variables', async () => {
    const h = harness(
      job({ items: [{ itemId: 'item-1', action: 'voice', status: 'pending', rayaBatchId: null }] }),
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.provider.dispatches).toHaveLength(1);
    const [contact] = h.provider.dispatches[0]!.contacts;
    expect(contact).toEqual({
      ref: 'item-1',
      name: 'Asha',
      phone: '+910000000001',
      variables: { role: 'Electrician', langs: '["hi","en"]' },
    });
    expect(h.itemMarks).toContainEqual({ itemId: 'item-1', status: 'resolved' });
  });

  it('marks a not-owned item skipped_not_owned', async () => {
    const h = harness(job(), {
      fetchDecryptedProfiles: async () =>
        ok({ profiles: [row({ item_id: 'item-1' })], skipped: ['item-2'] }),
    });
    await runCampaignJob('job-1', h.deps);

    expect(h.itemMarks).toContainEqual({
      itemId: 'item-2',
      status: 'skipped_not_owned',
      err: 'not_owned_by_org',
    });
  });

  it('marks an owned item with no phone skipped_no_contact and excludes it from the batch', async () => {
    const h = harness(
      job({ items: [{ itemId: 'item-1', action: 'voice', status: 'pending', rayaBatchId: null }] }),
      {
        fetchDecryptedProfiles: async () =>
          ok({
            profiles: [
              row({
                item_id: 'item-1',
                contact: {
                  name: { value: 'Asha', source: 'item' },
                  phone: { value: null, source: null },
                },
              }),
            ],
            skipped: [],
          }),
      },
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.itemMarks).toContainEqual({
      itemId: 'item-1',
      status: 'skipped_no_contact',
      err: 'no_phone',
    });
    expect(h.provider.dispatches).toHaveLength(0);
  });

  it('calls dispatch once and persists accepted (markSubmitted) vs rejected (failed)', async () => {
    const h = harness(job());
    h.provider.setReject('item-2', 'invalid phone number');
    await runCampaignJob('job-1', h.deps);

    expect(h.provider.dispatches).toHaveLength(1);
    expect(h.submitted).toEqual([{ itemId: 'item-1', rayaBatchId: 'mem-batch-1' }]);
    expect(h.itemMarks).toContainEqual({
      itemId: 'item-2',
      status: 'failed',
      err: 'invalid phone number',
    });
  });

  it('stores the raw provider response on the job', async () => {
    const h = harness(job());
    await runCampaignJob('job-1', h.deps);

    expect(h.providerResponses).toHaveLength(1);
    expect(h.providerResponses[0]).toMatchObject({
      create: expect.anything(),
      start: expect.anything(),
    });
  });

  it('never decrypts or dispatches a duplicate_active item', async () => {
    const h = harness(
      job({
        items: [
          { itemId: 'item-1', action: 'voice', status: 'duplicate_active', rayaBatchId: null },
        ],
      }),
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.fetchQueries).toHaveLength(0);
    expect(h.provider.dispatches).toHaveLength(0);
  });

  it('retry-safety: a job whose items already carry a raya_batch_id is never re-dispatched', async () => {
    const h = harness(
      job({
        items: [
          { itemId: 'item-1', action: 'voice', status: 'submitted', rayaBatchId: 'batch-prior' },
          { itemId: 'item-2', action: 'voice', status: 'pending', rayaBatchId: null },
        ],
      }),
    );
    await runCampaignJob('job-1', h.deps);

    expect(h.fetchQueries).toHaveLength(0);
    expect(h.provider.dispatches).toHaveLength(0);
    // item-2 was never decrypted (still `pending`, not `resolved`) on the
    // crashed attempt, so it's left alone rather than guessed at.
    expect(h.submitted).toHaveLength(0);
  });

  it('retry-safety resume: a mix of already-submitted + resolved items all end submitted under the known batch, with no second dispatch call', async () => {
    const h = harness(
      job({
        items: [
          { itemId: 'item-1', action: 'voice', status: 'submitted', rayaBatchId: 'batch-prior' },
          { itemId: 'item-2', action: 'voice', status: 'resolved', rayaBatchId: null },
          { itemId: 'item-3', action: 'voice', status: 'resolved', rayaBatchId: null },
        ],
      }),
    );
    await runCampaignJob('job-1', h.deps);

    // No re-decrypt, no second batch created at the provider.
    expect(h.fetchQueries).toHaveLength(0);
    expect(h.provider.dispatches).toHaveLength(0);
    // Every still-`resolved` item is resumed under the known batch id.
    expect(h.submitted).toEqual(
      expect.arrayContaining([
        { itemId: 'item-2', rayaBatchId: 'batch-prior' },
        { itemId: 'item-3', rayaBatchId: 'batch-prior' },
      ]),
    );
    expect(h.submitted).toHaveLength(2);
    // The already-submitted item-1 is untouched — forward-only guard, not re-marked.
    expect(h.submitted.find((s) => s.itemId === 'item-1')).toBeUndefined();
  });

  it('throws (BullMQ retry) when the provider dispatch fails', async () => {
    const h = harness(job(), {}, { attempt: 1, maxAttempts: 3 });
    h.deps.voice!.provider = new FailingVoiceProvider();

    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/raya down/);
    expect(h.jobStatuses).toEqual(['processing']); // never rolled up to terminal
    expect(h.submitted).toHaveLength(0);
  });

  it('fails leftover items on the final attempt after a dispatch failure', async () => {
    const h = harness(job(), {}, { attempt: 3, maxAttempts: 3 });
    h.deps.voice!.provider = new FailingVoiceProvider();

    await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow(/raya down/);
    expect(h.jobStatuses.at(-1)).toBe('failed');
    expect(h.pendingFails).toEqual(['job_failed']);
  });

  it('never logs contact PII', async () => {
    const h = harness(job());
    await runCampaignJob('job-1', h.deps);
    const serialized = JSON.stringify([...h.logs.info, ...h.logs.warn, ...h.logs.error]);
    expect(serialized).not.toContain('Asha');
    expect(serialized).not.toContain('+910000000001');
  });

  it('never writes contact PII into the item-level store calls (markItem/markSubmitted)', async () => {
    const h = harness(job());
    h.provider.setReject('item-2', 'invalid phone number');
    await runCampaignJob('job-1', h.deps);

    // itemMarks/submitted only ever carry ids, statuses, and provider batch
    // refs — never the decrypted name/phone that produced them.
    const serialized = JSON.stringify([...h.itemMarks, ...h.submitted]);
    expect(serialized).not.toContain('Asha');
    expect(serialized).not.toContain('+910000000001');
  });
});
