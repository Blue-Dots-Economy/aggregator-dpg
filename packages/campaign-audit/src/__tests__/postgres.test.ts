import { describe, it, expect, vi } from 'vitest';
import { PostgresCampaignAuditWriter } from '../postgres.js';
import { buildRequestedAudit, buildCompletedAudit, buildDumpAudit } from '../testing/index.js';

function stubDb() {
  const values = vi.fn().mockResolvedValue(undefined);
  return { db: { insert: () => ({ values }) } as never, values };
}

describe('PostgresCampaignAuditWriter', () => {
  it('writes a requested row with no outcome', async () => {
    const { db, values } = stubDb();
    await new PostgresCampaignAuditWriter(db).recordRequested(buildRequestedAudit());
    const row = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.event).toBe('requested');
    expect(row.outcome).toBeUndefined();
    expect(row.requestedCount).toBe(3);
  });

  it('writes a completed row carrying the org for single-scan org queries', async () => {
    const { db, values } = stubDb();
    await new PostgresCampaignAuditWriter(db).recordCompleted(buildCompletedAudit());
    const row = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.event).toBe('completed');
    expect(row.actorOrgId).toBe('org_test');
    expect(row.outcome).toBe('succeeded');
  });

  it('writes a dump row with no org and an empty pii_fields', async () => {
    const { db, values } = stubDb();
    await new PostgresCampaignAuditWriter(db).recordDumpAccess(buildDumpAudit());
    const row = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.channel).toBe('dump');
    expect(row.actorOrgId).toBeUndefined();
    expect(row.piiFields).toEqual([]);
  });

  it('returns an err Result instead of throwing when the insert fails', async () => {
    const values = vi.fn().mockRejectedValue(new Error('db down'));
    const db = { insert: () => ({ values }) } as never;
    const r = await new PostgresCampaignAuditWriter(db).recordRequested(buildRequestedAudit());
    expect(r.success).toBe(false);
  });
});
