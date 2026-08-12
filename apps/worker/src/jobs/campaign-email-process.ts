/**
 * `campaign-email` job processor (aggregator-dpg#578).
 *
 * Builds the real collaborators from the worker's environment (Signals client,
 * mailer, send concurrency) and delegates to the pure `runEmailSend`
 * orchestrator. A missing Signals client (terminal misconfiguration) is logged
 * and returns without throwing; a decrypt failure or contract violation
 * propagates so the (send-once) job is marked failed. Belongs to
 * `@aggregator-dpg/worker`.
 */
import type { CampaignEmailJob } from '@aggregator-dpg/queue';
import { getMailer } from '@aggregator-dpg/mailer';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { runEmailSend } from '../services/campaign-email/index.js';

/**
 * Runs one campaign email job.
 *
 * @param data - The enqueued job payload (org id, item ids, subject, body, reply-to, purpose, request id).
 */
export async function processCampaignEmail(data: CampaignEmailJob): Promise<void> {
  const log = logger.child({ operation: 'campaign.email', org_id: data.orgId });
  const ss = getSignalStackWriter();

  if (!ss) {
    log.error({ status: 'failure', step: 'config', reason: 'signalstack_not_configured' });
    return;
  }

  await runEmailSend(
    {
      orgId: data.orgId,
      itemIds: data.itemIds,
      subject: data.subject,
      bodyMarkdown: data.bodyMarkdown,
      ...(data.replyTo ? { replyTo: data.replyTo } : {}),
      ...(data.purpose ? { purpose: data.purpose } : {}),
      ...(data.requestId ? { requestId: data.requestId } : {}),
    },
    {
      fetchDecryptedProfiles: (q) => ss.fetchDecryptedProfiles(q),
      sendMail: (input) => getMailer().send(input),
      concurrency: config.EMAIL_SEND_CONCURRENCY,
      log,
    },
  );
}
