/**
 * Behaviour every writer must share. Run against the fake here, and against the
 * real Postgres writer in its integration test, so the two cannot drift.
 *
 * @module @aggregator-dpg/campaign-audit/__tests__/conformance
 */
import { describe, it, expect } from 'vitest';
import type { CampaignAuditWriterBase } from '../interface.js';
import { buildRequestedAudit, buildCompletedAudit, buildDumpAudit } from '../testing/index.js';

/**
 * Runs the shared conformance suite against a writer produced by `makeWriter`.
 *
 * @param makeWriter - Factory returning a fresh {@link CampaignAuditWriterBase}
 *   instance for each test.
 */
export function runAuditWriterConformance(makeWriter: () => CampaignAuditWriterBase): void {
  describe('conformance', () => {
    it('accepts a requested row', async () => {
      const w = makeWriter();
      const r = await w.recordRequested(buildRequestedAudit());
      expect(r.success).toBe(true);
    });

    it('accepts a completed row for the same correlation id', async () => {
      const w = makeWriter();
      const id = '00000000-0000-4000-8000-0000000000aa';
      expect((await w.recordRequested(buildRequestedAudit({ correlationId: id }))).success).toBe(
        true,
      );
      expect((await w.recordCompleted(buildCompletedAudit({ correlationId: id }))).success).toBe(
        true,
      );
    });

    it('accepts a dump row with no org', async () => {
      const w = makeWriter();
      const r = await w.recordDumpAccess(buildDumpAudit());
      expect(r.success).toBe(true);
    });

    it('exposes no mutation surface', () => {
      const w = makeWriter() as unknown as Record<string, unknown>;
      // The append-only guarantee is the ABSENCE of these.
      expect(w.update).toBeUndefined();
      expect(w.delete).toBeUndefined();
      expect(w.find).toBeUndefined();
    });
  });
}
