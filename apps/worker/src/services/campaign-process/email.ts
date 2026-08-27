/**
 * Campaign email channel (aggregator-dpg#578) on the async-job engine (#579).
 *
 * Runs one `campaign_job` whose channel is `email`: decrypt the still-open
 * recipients (chunked, ownership-scoped, projecting only the contact fields the
 * template's placeholders reference) → render the submitted Markdown once →
 * send per recipient with bounded concurrency → write each recipient's terminal
 * status. Structured the way `voice.ts` is: `index.ts` owns the job lifecycle
 * and dispatches here on `job.channel`.
 *
 * Retry-safe by construction rather than by suppressing retries: items already
 * in a terminal status are excluded from the decrypt request entirely, so a
 * BullMQ retry (`CAMPAIGN_EMAIL_ATTEMPTS`, default 3) re-emails nobody already
 * marked `sent`. This is deliberately NOT the job-level `notified_at` guard the
 * export channel uses — export sends ONE message per job, so a job-level stamp
 * suffices, whereas this channel sends one per recipient and a job that got
 * halfway through must resume rather than be skipped wholesale.
 *
 * Unlike the export and voice channels this one does not mark decrypted items
 * `resolved`: `sent` is its only success write, so the intermediate mark would
 * be a wasted write per recipient.
 *
 * Never logs PII — the per-recipient trace carries the item id and status only,
 * never the resolved address. Belongs to `@aggregator-dpg/worker`.
 */
import { z } from 'zod';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type {
  SignalStackFetchDecryptedProfilesQuery,
  SignalStackDecryptedProfiles,
  SignalStackDecryptedProfileRow,
} from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import {
  placeholderValues,
  requiredContactFields,
  type ContactField,
} from '@aggregator-dpg/campaign-template';
import { renderEmail } from '@aggregator-dpg/campaign-template/render';
import { TERMINAL_ITEM_STATUSES, type ProcessingJob } from '../campaign-job-client.js';
import { chunkArray, type CampaignJobDeps } from './index.js';

/** Email-channel collaborators (decrypt + mailer). */
export interface EmailCollaborators {
  fetchDecryptedProfiles: (
    q: SignalStackFetchDecryptedProfilesQuery,
  ) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
}

/**
 * The email channel's `content` block as persisted on the job row.
 *
 * Re-validated here rather than trusted: the row outlives the request that
 * wrote it, and a malformed template must fail the job's items deterministically
 * instead of rendering something unintended into a participant's inbox.
 */
const emailContentSchema = z.object({
  subject: z.string().min(1),
  body_markdown: z.string().min(1),
  reply_to: z.string().optional(),
});

/** The message the caller submitted (the job row's `content` block). */
export interface EmailTemplate {
  subject: string;
  bodyMarkdown: string;
  replyTo?: string;
}

/**
 * Runs the email channel for one job: decrypt the still-open recipients →
 * render → send → per-item terminal status.
 *
 * @param job - The job to process (`job.channel === 'email'`).
 * @param deps - Injected job-client, email collaborators, config, logger.
 * @throws {Error} If `deps.email` is not wired, or the decrypt fails
 *   transiently (so BullMQ retries). A malformed stored `content` does NOT
 *   throw — a retry could not fix it, so the job's items are failed instead.
 */
export async function runEmailForJob(job: ProcessingJob, deps: CampaignJobDeps): Promise<void> {
  const email = deps.email;
  if (!email) throw new Error('campaign email collaborators not wired');

  const base = {
    operation: 'campaign.email',
    job_id: job.id,
    org_id: job.signalstackOrgId,
    requested: job.items.length,
  };
  const start = Date.now();

  const parsed = emailContentSchema.safeParse(job.content);
  if (!parsed.success) {
    // Deterministic — a retry cannot fix it. Fail every item that is still
    // actionable so the roll-up marks the job `failed` instead of leaving it
    // `processing` for the watchdog to re-queue forever.
    deps.log.error({
      ...base,
      status: 'failure',
      step: 'content',
      reason: 'invalid_email_content',
      error: parsed.error.issues.map((i) => i.path.join('.')).join(','),
    });
    for (const item of job.items) {
      if (!TERMINAL_ITEM_STATUSES.includes(item.status)) {
        await deps.client.markItem(job.id, item.itemId, 'failed', 'invalid_email_content');
      }
    }
    return;
  }
  const content = parsed.data;

  const open = job.items.filter((i) => !TERMINAL_ITEM_STATUSES.includes(i.status));
  if (open.length === 0) {
    deps.log.info({
      ...base,
      status: 'skipped',
      reason: 'all_items_terminal',
      latency_ms: Date.now() - start,
    });
    return;
  }

  const rows = await decryptEmailItems(job, deps, email, content);
  if (rows.length === 0) {
    // Nothing owned to email; every id was marked `skipped_not_owned` above.
    deps.log.warn({
      ...base,
      status: 'skipped',
      reason: 'no_resolvable_items',
      latency_ms: Date.now() - start,
      sent: 0,
    });
    return;
  }

  const summary = await sendCampaignEmails(
    rows,
    {
      subject: content.subject,
      bodyMarkdown: content.body_markdown,
      ...(content.reply_to ? { replyTo: content.reply_to } : {}),
    },
    {
      sendMail: email.sendMail,
      concurrency: deps.config.emailSendConcurrency,
      markRecipient: (itemId, status, detail) =>
        deps.client.markItem(job.id, itemId, status, detail?.reason, detail?.providerRef),
      log: deps.log,
    },
  );
  await deps.client.heartbeat(job.id);

  deps.log.info({
    ...base,
    status: summary.failed > 0 ? 'partial' : 'success',
    latency_ms: Date.now() - start,
    sent: summary.sent,
    skipped_no_contact: summary.skippedNoContact,
    failed: summary.failed,
  });
}

/**
 * Decrypts every still-open item on the job (chunked), marking unowned ids
 * `skipped_not_owned` and beating the heartbeat per chunk. Items already in a
 * terminal status are excluded from the request entirely — a retry never
 * re-decrypts or re-emails them. Only the contact fields the template actually
 * uses are requested: the address always, `name`/`phone` only when a
 * placeholder references them.
 *
 * @param job - The job being processed.
 * @param deps - Injected collaborators (client, config, logger).
 * @param email - The email collaborators (already null-checked by the caller).
 * @param content - The validated message, whose placeholders drive the projection.
 * @returns The resolved profile rows (owned items only).
 * @throws {Error} On a transient decrypt failure (so BullMQ retries), or when a
 *   contact projection comes back with no contact block at all — an older
 *   Signals that strips it would make every recipient look address-less, so
 *   fail loud rather than skip the whole batch (Signals #521).
 */
async function decryptEmailItems(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  email: EmailCollaborators,
  content: { subject: string; body_markdown: string },
): Promise<SignalStackDecryptedProfileRow[]> {
  const contact: ContactField[] = [
    ...new Set<ContactField>([
      'email',
      ...requiredContactFields(content.subject, content.body_markdown),
    ]),
  ];
  const openItemIds = job.items
    .filter((i) => !TERMINAL_ITEM_STATUSES.includes(i.status))
    .map((i) => i.itemId);
  const resolvedRows: SignalStackDecryptedProfileRow[] = [];

  for (const chunk of chunkArray(openItemIds, deps.config.decryptChunk)) {
    const query: SignalStackFetchDecryptedProfilesQuery = {
      actingOrgId: job.signalstackOrgId,
      itemIds: chunk,
      // contact-only projection: no item_state (fields:[]), just the contact
      // fields this message needs, with provenance (Signals #521).
      fields: [],
      contact,
      ...(job.requestId ? { requestId: job.requestId } : {}),
    };
    const result = await email.fetchDecryptedProfiles(query);
    if (!result.success) {
      throw new Error(
        `campaign email decrypt failed: ${result.error.code}: ${result.error.message}`,
      );
    }
    const { profiles, skipped } = result.value;

    if (profiles.length > 0 && !profiles.some((p) => p.contact !== undefined)) {
      throw new Error(
        'campaign email decrypt returned no contact block — Signals participant/decrypt predates #521',
      );
    }

    // No `resolved` mark: `sent` is this channel's only success write.
    resolvedRows.push(...profiles);
    for (const missing of skipped) {
      // Not a failure: the org simply doesn't own this item, so it is skipped
      // (and never leaked). Skips don't make the job `partial`.
      await deps.client.markItem(job.id, missing, 'skipped_not_owned', 'not_owned_by_org');
    }
    await deps.client.heartbeat(job.id);
  }
  return resolvedRows;
}

/** Per-recipient outcome the caller persists as the item's terminal status. */
export type EmailRecipientStatus = 'sent' | 'skipped_no_contact' | 'failed';

/** Injected collaborators — narrow types so the loop is trivially faked. */
export interface EmailSendDeps {
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
  /** How many recipients to send in parallel (`EMAIL_SEND_CONCURRENCY`). */
  concurrency: number;
  /**
   * Records one recipient's terminal outcome. `providerRef` is the mailer's
   * message id, present only on `sent`.
   */
  markRecipient: (
    itemId: string,
    status: EmailRecipientStatus,
    detail?: { reason?: string; providerRef?: string },
  ) => Promise<void>;
  log: { info(obj: object): void };
}

/** Tally of the loop's outcomes, for the caller's summary log. */
export interface EmailSendSummary {
  sent: number;
  skippedNoContact: number;
  failed: number;
}

/**
 * Renders and sends the campaign message to every supplied recipient row.
 *
 * A per-recipient send failure is recorded (`failed`) and does NOT abort the
 * batch — one bad address must not strand the rest. The caller's job roll-up
 * turns a mix into `partial`.
 *
 * @param rows - Decrypted profile rows to email (already ownership-scoped).
 * @param template - Subject / Markdown body / optional Reply-To.
 * @param deps - Mailer, send concurrency, per-recipient reporter, logger.
 * @returns The outcome tally across all recipients.
 */
export async function sendCampaignEmails(
  rows: readonly SignalStackDecryptedProfileRow[],
  template: EmailTemplate,
  deps: EmailSendDeps,
): Promise<EmailSendSummary> {
  const summary: EmailSendSummary = { sent: 0, skippedNoContact: 0, failed: 0 };

  await mapWithConcurrency([...rows], deps.concurrency, async (profile) => {
    const email = profile.contact?.email?.value ?? '';
    let status: EmailRecipientStatus;

    if (!email) {
      // Not a failure: the participant simply has no email address on file.
      summary.skippedNoContact += 1;
      status = 'skipped_no_contact';
      await deps.markRecipient(profile.item_id, status, { reason: 'no_email_address' });
    } else {
      const values = placeholderValues({
        name: profile.contact?.name?.value ?? null,
        email: profile.contact?.email?.value ?? null,
        phone: profile.contact?.phone?.value ?? null,
      });
      const rendered = renderEmail({
        subject: template.subject,
        bodyMarkdown: template.bodyMarkdown,
        values,
      });
      const res = await deps.sendMail({
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(template.replyTo ? { replyTo: template.replyTo } : {}),
      });
      if (res.ok) {
        summary.sent += 1;
        status = 'sent';
        await deps.markRecipient(profile.item_id, status, { providerRef: res.value.messageId });
      } else {
        summary.failed += 1;
        status = 'failed';
        await deps.markRecipient(profile.item_id, status, {
          reason: `${res.error.code}: ${res.error.message}`,
        });
      }
    }

    // Per-recipient trace — item_id + status only, never the resolved email.
    deps.log.info({ operation: 'campaign.email.recipient', item_id: profile.item_id, status });
  });

  return summary;
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index]!);
    }
  });
  await Promise.all(runners);
}
