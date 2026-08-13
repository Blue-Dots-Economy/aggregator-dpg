/**
 * `campaign-process` job processor (aggregator-dpg#579).
 *
 * Builds the real collaborators from the worker's environment (job DB client,
 * Signals client, S3, mailer) and delegates to the pure `runCampaignJob`
 * orchestrator. A missing Signals client (terminal misconfiguration) fails the
 * job so BullMQ surfaces it; any other collaborator rejection propagates so
 * BullMQ retries. Belongs to `@aggregator-dpg/worker`.
 */
import type { CampaignProcessJob } from '@aggregator-dpg/queue';
import { getMailer } from '@aggregator-dpg/mailer';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { putObject, signExportDownloadUrl } from '../object-storage.js';
import * as jobClient from '../services/campaign-job-client.js';
import { runCampaignJob } from '../services/campaign-process/index.js';

/**
 * Runs one campaign-process job.
 *
 * @param data - The enqueued payload — just the `campaign_job.id`.
 */
export async function processCampaignJob(data: CampaignProcessJob): Promise<void> {
  const log = logger.child({ operation: 'campaign.process', job_id: data.jobId });
  const ss = getSignalStackWriter();
  if (!ss) {
    log.error({ status: 'failure', step: 'config', reason: 'signalstack_not_configured' });
    throw new Error('signalstack client not configured');
  }

  await runCampaignJob(data.jobId, {
    client: jobClient,
    export: {
      fetchDecryptedProfiles: (q) => ss.fetchDecryptedProfiles(q),
      putObject,
      signDownloadUrl: signExportDownloadUrl,
      sendMail: (input) => getMailer().send(input),
    },
    config: {
      decryptChunk: config.CAMPAIGN_DECRYPT_CHUNK,
      fieldSet: config.CAMPAIGN_EXPORT_FIELDS,
      ...(config.CAMPAIGN_EXPORT_RECIPIENT
        ? { recipientOverride: config.CAMPAIGN_EXPORT_RECIPIENT }
        : {}),
      ...(config.EXPORT_NETWORK_ADMIN_EMAIL
        ? { adminEmailFallback: config.EXPORT_NETWORK_ADMIN_EMAIL }
        : {}),
    },
    log,
  });
}
