/**
 * `campaign-process` job processor (aggregator-dpg#579).
 *
 * Builds the real collaborators from the worker's environment (job DB client,
 * Signals client, S3, mailer) for every channel and delegates to the pure
 * `runCampaignJob` orchestrator, which dispatches on the job's channel. A missing Signals client (terminal misconfiguration) fails the
 * job so BullMQ surfaces it; any other collaborator rejection propagates so
 * BullMQ retries — except on the last attempt, where the orchestrator records
 * a terminal `failed` with the real reason instead of stranding the job in
 * `processing`. Belongs to `@aggregator-dpg/worker`.
 */
import type { CampaignProcessJob } from '@aggregator-dpg/queue';
import { getMailer } from '@aggregator-dpg/mailer';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { putObject, signExportDownloadUrl } from '../object-storage.js';
import * as jobClient from '../services/campaign-job-client.js';
import { runCampaignJob } from '../services/campaign-process/index.js';

/** Where this run sits in BullMQ's retry sequence. */
export interface CampaignAttempt {
  /** 1-based attempt number for this run. */
  attempt: number;
  /** Total attempts BullMQ will make before giving up. */
  maxAttempts: number;
}

/**
 * Runs one campaign-process job.
 *
 * @param data - The enqueued payload — just the `campaign_job.id`.
 * @param attempt - Retry position, so the last attempt can mark the job failed.
 */
export async function processCampaignJob(
  data: CampaignProcessJob,
  attempt: CampaignAttempt = { attempt: 1, maxAttempts: 1 },
): Promise<void> {
  const log = logger.child({ operation: 'campaign.process', job_id: data.jobId });
  const ss = getSignalStackWriter();
  if (!ss) {
    log.error({ status: 'failure', step: 'config', reason: 'signalstack_not_configured' });
    throw new Error('signalstack client not configured');
  }

  await runCampaignJob(data.jobId, {
    client: jobClient,
    fetchDecryptedProfiles: (q) => ss.fetchDecryptedProfiles(q),
    export: {
      putObject,
      signDownloadUrl: signExportDownloadUrl,
      sendMail: (input) => getMailer().send(input),
    },
    email: {
      sendMail: (input) => getMailer().send(input),
    },
    config: {
      decryptChunk: config.CAMPAIGN_DECRYPT_CHUNK,
      fieldSet: config.CAMPAIGN_EXPORT_FIELDS,
      recipientMode: config.CAMPAIGN_EXPORT_RECIPIENT,
      emailSendConcurrency: config.EMAIL_SEND_CONCURRENCY,
      ...(config.EXPORT_NETWORK_ADMIN_EMAIL
        ? { networkAdminEmail: config.EXPORT_NETWORK_ADMIN_EMAIL }
        : {}),
    },
    log,
    attempt,
  });
}
