/**
 * `campaign-export` job processor (aggregator-dpg#579).
 *
 * Builds the real collaborators from the worker's environment (Signals client,
 * S3, mailer) and delegates to the pure `runExport` orchestrator. The delivery
 * recipient is the requesting aggregator's email, resolved by the API before
 * enqueue and carried on the job — the worker does not look it up. A missing
 * Signals client (terminal misconfiguration) is logged and returns without
 * throwing; any other collaborator rejection propagates so BullMQ retries.
 * Belongs to `@aggregator-dpg/worker`.
 */
import type { CampaignExportJob } from '@aggregator-dpg/queue';
import { getMailer } from '@aggregator-dpg/mailer';
import { logger } from '../logger.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { putObject, signExportDownloadUrl } from '../object-storage.js';
import { runExport } from '../services/campaign-export/index.js';

/**
 * Runs one campaign PII export job.
 *
 * @param data - The enqueued job payload (org id, item ids, recipient email, purpose, request id).
 */
export async function processCampaignExport(data: CampaignExportJob): Promise<void> {
  const log = logger.child({ operation: 'campaign.export', org_id: data.orgId });
  const ss = getSignalStackWriter();

  if (!ss) {
    log.error({ status: 'failure', step: 'config', reason: 'signalstack_not_configured' });
    return;
  }

  await runExport(
    {
      orgId: data.orgId,
      itemIds: data.itemIds,
      ...(data.purpose ? { purpose: data.purpose } : {}),
      ...(data.requestId ? { requestId: data.requestId } : {}),
    },
    {
      fetchDecryptedProfiles: (q) => ss.fetchDecryptedProfiles(q),
      putObject,
      signDownloadUrl: signExportDownloadUrl,
      sendMail: (input) => getMailer().send(input),
      recipientEmail: data.recipientEmail,
      log,
    },
  );
}
