/**
 * Behavioural conformance suite for {@link CampaignJobStoreBase}.
 *
 * Both the in-memory store (unit test) and the Postgres store (integration
 * test against a live DB) run this exact suite, so the two impls are held to
 * one contract. Every test uses a unique `signalstackOrgId` and item-id prefix
 * so runs never interfere — important for the shared-DB Postgres run.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CampaignJobStoreBase, CreateJobInput } from '../interface.js';

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`store error: ${JSON.stringify(r.error)}`);
  return r.value;
}

export interface ConformanceOpts {
  /** A valid aggregator id (Postgres needs an existing FK target; memory ignores it). */
  aggregatorId: string;
}

export function runStoreConformance(
  makeStore: () => CampaignJobStoreBase,
  opts: ConformanceOpts,
): void {
  const base = (over: Partial<CreateJobInput> = {}): CreateJobInput => {
    const p = randomUUID().slice(0, 8);
    return {
      aggregatorId: opts.aggregatorId,
      signalstackOrgId: `org-${p}`,
      channel: 'export',
      metadata: [{ key: 'purpose', value: 'audit' }],
      content: {},
      requestedBy: 'user@org.example',
      // item_id is a uuid column (Signals item ids), so fixtures must be real uuids.
      items: [
        { itemId: randomUUID(), action: null },
        { itemId: randomUUID(), action: null },
      ],
      ...over,
    };
  };

  describe('createJob', () => {
    it('creates a job with one pending item per input item', async () => {
      const store = makeStore();
      const input = base();
      const { job, created } = unwrap(await store.createJob(input));
      expect(created).toBe(true);
      expect(job.status).toBe('queued');
      const view = unwrap(await store.getJob(job.id, input.signalstackOrgId));
      expect(view!.counts).toEqual({
        total: 2,
        pending: 2,
        resolved: 0,
        submitted: 0,
        sent: 0,
        skipped_not_owned: 0,
        skipped_no_contact: 0,
        duplicate_active: 0,
        failed: 0,
      });
      expect(view!.metadata).toEqual([{ key: 'purpose', value: 'audit' }]);
    });

    it('is idempotent on idempotencyKey (same job, created:false, no extra items)', async () => {
      const store = makeStore();
      const input = base({ idempotencyKey: `k-${randomUUID()}` });
      const first = unwrap(await store.createJob(input));
      const second = unwrap(await store.createJob(input));
      expect(second.created).toBe(false);
      expect(second.job.id).toBe(first.job.id);
      const view = unwrap(await store.getJob(first.job.id, input.signalstackOrgId));
      expect(view!.counts.total).toBe(2);
    });

    it('scopes idempotencyKey per tenant: the same key in another org creates its own job', async () => {
      const store = makeStore();
      const key = `k-${randomUUID()}`;
      const orgA = unwrap(await store.createJob(base({ idempotencyKey: key })));
      const inputB = base({ idempotencyKey: key });
      const orgB = unwrap(await store.createJob(inputB));

      // Callers pick their own keys. A global unique index would let one org's
      // key silently swallow another's request — and the 202 would hand back a
      // job_id that org can never read (getJob is org-scoped), so their export
      // would appear to vanish.
      expect(orgB.created).toBe(true);
      expect(orgB.job.id).not.toBe(orgA.job.id);
      expect(unwrap(await store.getJob(orgB.job.id, inputB.signalstackOrgId))).not.toBeNull();
    });
  });

  describe('tenant scoping', () => {
    it('getJob / getJobItems return null for another org', async () => {
      const store = makeStore();
      const input = base();
      const { job } = unwrap(await store.createJob(input));
      expect(unwrap(await store.getJob(job.id, 'someone-else'))).toBeNull();
      expect(unwrap(await store.getJobItems(job.id, 'someone-else'))).toBeNull();
    });
  });

  describe('item status + roll-up', () => {
    it('rolls up to succeeded when every item resolves', async () => {
      const store = makeStore();
      const input = base();
      const { job } = unwrap(await store.createJob(input));
      unwrap(await store.markItem(job.id, input.items[0]!.itemId, 'resolved'));
      unwrap(await store.markItem(job.id, input.items[1]!.itemId, 'resolved'));
      expect(unwrap(await store.rollUpStatus(job.id))).toBe('completed');
      const view = unwrap(await store.getJob(job.id, input.signalstackOrgId));
      expect(view!.status).toBe('completed');
    });

    it('rolls up to partially_failed on a mix and surfaces the error reason', async () => {
      const store = makeStore();
      const input = base();
      const { job } = unwrap(await store.createJob(input));
      unwrap(await store.markItem(job.id, input.items[0]!.itemId, 'resolved'));
      unwrap(await store.markItem(job.id, input.items[1]!.itemId, 'failed', 'not owned'));
      expect(unwrap(await store.rollUpStatus(job.id))).toBe('partial');
      const items = unwrap(await store.getJobItems(job.id, input.signalstackOrgId))!;
      expect(items.find((i) => i.itemId === input.items[1]!.itemId)!.errorReason).toBe('not owned');
    });

    it('rolls up to failed when every item fails', async () => {
      const store = makeStore();
      const input = base();
      const { job } = unwrap(await store.createJob(input));
      unwrap(await store.markItem(job.id, input.items[0]!.itemId, 'failed', 'x'));
      unwrap(await store.markItem(job.id, input.items[1]!.itemId, 'failed', 'y'));
      expect(unwrap(await store.rollUpStatus(job.id))).toBe('failed');
    });

    it('stays processing while any item is still pending', async () => {
      const store = makeStore();
      const input = base();
      const { job } = unwrap(await store.createJob(input));
      unwrap(await store.markItem(job.id, input.items[0]!.itemId, 'resolved'));
      expect(unwrap(await store.rollUpStatus(job.id))).toBe('processing');
    });

    it('allows resolved -> sent: resolve is a step, not a terminal', async () => {
      // The multi-write channels resolve first and then act (email: sent,
      // voice: submitted). If `resolved` were in the retry guard this second
      // write would be refused and every email job would report 0 sent.
      const store = makeStore();
      const input = base();
      const { job } = unwrap(await store.createJob(input));
      const id = input.items[0]!.itemId;
      unwrap(await store.markItem(job.id, id, 'resolved'));
      unwrap(await store.markItem(job.id, id, 'sent', undefined, 'msg-123'));
      const items = unwrap(await store.getJobItems(job.id, input.signalstackOrgId))!;
      const item = items.find((i) => i.itemId === id)!;
      expect(item.status).toBe('sent');
      expect(item.providerRef).toBe('msg-123');
    });

    it('markItem is forward-only — a terminal item is not overwritten', async () => {
      const store = makeStore();
      const input = base();
      const { job } = unwrap(await store.createJob(input));
      unwrap(await store.markItem(job.id, input.items[0]!.itemId, 'sent'));
      unwrap(await store.markItem(job.id, input.items[0]!.itemId, 'failed', 'late failure'));
      const items = unwrap(await store.getJobItems(job.id, input.signalstackOrgId))!;
      const item = items.find((i) => i.itemId === input.items[0]!.itemId)!;
      expect(item.status).toBe('sent');
      expect(item.errorReason).toBeNull();
    });
  });

  describe('skip semantics (spec: skips are not failures)', () => {
    it('a skipped item does not make the job partial — it completes', async () => {
      const store = makeStore();
      const input = base();
      const { job } = unwrap(await store.createJob(input));
      unwrap(await store.markItem(job.id, input.items[0]!.itemId, 'resolved'));
      unwrap(
        await store.markItem(
          job.id,
          input.items[1]!.itemId,
          'skipped_not_owned',
          'not_owned_by_org',
        ),
      );
      expect(unwrap(await store.rollUpStatus(job.id))).toBe('completed');
      const items = unwrap(await store.getJobItems(job.id, input.signalstackOrgId))!;
      const skipped = items.find((i) => i.itemId === input.items[1]!.itemId)!;
      // the reason lands in skip_reason, never error_reason
      expect(skipped.skipReason).toBe('not_owned_by_org');
      expect(skipped.errorReason).toBeNull();
    });

    it('a real failure alongside a success rolls up to partial', async () => {
      const store = makeStore();
      const input = base();
      const { job } = unwrap(await store.createJob(input));
      unwrap(await store.markItem(job.id, input.items[0]!.itemId, 'resolved'));
      unwrap(await store.markItem(job.id, input.items[1]!.itemId, 'failed', 'upstream 500'));
      expect(unwrap(await store.rollUpStatus(job.id))).toBe('partial');
    });

    it('treats sent as a success terminal (email channel)', async () => {
      const store = makeStore();
      const input = base();
      const { job } = unwrap(await store.createJob(input));
      for (const i of input.items) unwrap(await store.markItem(job.id, i.itemId, 'sent'));
      expect(unwrap(await store.rollUpStatus(job.id))).toBe('completed');
    });
  });

  describe('active-job cap', () => {
    it('counts only queued/processing jobs for the org', async () => {
      const store = makeStore();
      const org = `org-${randomUUID().slice(0, 8)}`;
      const a = unwrap(await store.createJob(base({ signalstackOrgId: org })));
      unwrap(await store.createJob(base({ signalstackOrgId: org })));
      expect(unwrap(await store.countActiveJobs(org))).toBe(2);
      unwrap(await store.setJobStatus(a.job.id, 'completed'));
      expect(unwrap(await store.countActiveJobs(org))).toBe(1);
      expect(unwrap(await store.countActiveJobs('nobody'))).toBe(0);
    });

    it('scopes the active count to one channel when asked', async () => {
      const store = makeStore();
      const org = `org-${randomUUID().slice(0, 8)}`;
      unwrap(await store.createJob(base({ signalstackOrgId: org, channel: 'export' })));
      unwrap(await store.createJob(base({ signalstackOrgId: org, channel: 'email' })));
      expect(unwrap(await store.countActiveJobs(org))).toBe(2);
      // an in-flight email job must not consume the export channel's cap
      expect(unwrap(await store.countActiveJobs(org, 'export'))).toBe(1);
      expect(unwrap(await store.countActiveJobs(org, 'email'))).toBe(1);
      expect(unwrap(await store.countActiveJobs(org, 'voice'))).toBe(0);
    });
  });

  describe('listJobs', () => {
    it('returns the org jobs newest-first, filtered by channel, with a cursor', async () => {
      const store = makeStore();
      const org = `org-${randomUUID().slice(0, 8)}`;
      const first = unwrap(await store.createJob(base({ signalstackOrgId: org })));
      const second = unwrap(await store.createJob(base({ signalstackOrgId: org })));
      const page1 = unwrap(await store.listJobs(org, { limit: 1 }));
      expect(page1.jobs).toHaveLength(1);
      expect(page1.jobs[0]!.id).toBe(second.job.id);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = unwrap(await store.listJobs(org, { limit: 1, cursor: page1.nextCursor }));
      expect(page2.jobs[0]!.id).toBe(first.job.id);
      // channel filter
      const emailOrg = `org-${randomUUID().slice(0, 8)}`;
      unwrap(await store.createJob(base({ signalstackOrgId: emailOrg })));
      const emailOnly = unwrap(await store.listJobs(emailOrg, { channel: 'email' }));
      expect(emailOnly.jobs).toHaveLength(0);
    });
  });

  describe('getJobForProcessing', () => {
    it('loads the job unscoped with its items', async () => {
      const store = makeStore();
      const input = base();
      const { job } = unwrap(await store.createJob(input));
      const proc = unwrap(await store.getJobForProcessing(job.id))!;
      expect(proc.channel).toBe('export');
      expect(proc.signalstackOrgId).toBe(input.signalstackOrgId);
      expect(proc.requestedBy).toBe('user@org.example');
      expect(proc.items.map((i) => i.itemId).sort()).toEqual(
        input.items.map((i) => i.itemId).sort(),
      );
    });

    it('returns null for an unknown job', async () => {
      const store = makeStore();
      expect(unwrap(await store.getJobForProcessing(randomUUID()))).toBeNull();
    });
  });

  describe('heartbeat + claimStalledJobs', () => {
    it('claims processing jobs with a stale heartbeat, leaves pending/fresh alone', async () => {
      const store = makeStore();
      const input = base();
      const { job } = unwrap(await store.createJob(input));
      // pending job (never heartbeated) — never claimed, even with a future cutoff.
      expect(unwrap(await store.claimStalledJobs(-1))).not.toContain(job.id);
      unwrap(await store.setJobStatus(job.id, 'processing'));
      unwrap(await store.heartbeat(job.id));
      // fresh heartbeat — not stale under a real cutoff.
      expect(unwrap(await store.claimStalledJobs(3600))).not.toContain(job.id);
      // future cutoff (-1s) — the processing+heartbeated job is "stale".
      expect(unwrap(await store.claimStalledJobs(-1))).toContain(job.id);
    });
  });
}
