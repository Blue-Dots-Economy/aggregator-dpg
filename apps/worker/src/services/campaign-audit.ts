/**
 * Worker-side audit writer accessor (#617). Mirrors the API's
 * `apps/api/src/services/campaign-audit/index.ts`, against the worker's own
 * database handle — the worker writes the `completed` row once a campaign job
 * reaches a terminal status (see `./campaign-process/index.ts`'s
 * `safeAuditWorker`).
 *
 * @module @aggregator-dpg/worker
 */
import { PostgresCampaignAuditWriter } from '@aggregator-dpg/campaign-audit';
import type { CampaignAuditWriterBase } from '@aggregator-dpg/campaign-audit';
import { getDb } from '../db.js';

let writer: CampaignAuditWriterBase | null = null;

/**
 * Returns the process-wide {@link CampaignAuditWriterBase}, lazily
 * constructing the Postgres-backed implementation (writing to
 * `campaign_pii_audit`) on first use.
 *
 * @returns The singleton audit writer.
 */
export function getCampaignAuditWriter(): CampaignAuditWriterBase {
  if (!writer) writer = new PostgresCampaignAuditWriter(getDb() as never);
  return writer;
}

/**
 * Test seam — installs a replacement audit writer (typically
 * `CampaignAuditWriterFake` from `@aggregator-dpg/campaign-audit/testing`),
 * or clears the override.
 *
 * @param w - The writer to install, or `null` to reset so the next
 *   {@link getCampaignAuditWriter} call rebuilds the real Postgres-backed
 *   singleton.
 */
export function _setCampaignAuditWriter(w: CampaignAuditWriterBase | null): void {
  writer = w;
}
