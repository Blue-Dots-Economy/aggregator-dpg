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
 * Delivery is **at-least-once, per recipient**. Items already in a terminal
 * status are excluded from the decrypt request entirely, so a BullMQ retry
 * (`CAMPAIGN_EMAIL_ATTEMPTS`, default 3) re-emails nobody already marked
 * `sent` — but the mailer send and the `sent` write are two steps, so a crash
 * (or a failed status write) between them leaves the item open and the retry
 * sends again. SMTP and SES offer no idempotency key to close that window, so
 * it is accepted and documented rather than hidden. This is deliberately NOT
 * the job-level `notified_at` guard the export channel uses — export sends ONE
 * message per job, so a job-level stamp suffices, whereas this channel sends
 * one per recipient and a job that got halfway through must resume rather than
 * be skipped wholesale.
 *
 * Unlike the export and voice channels this one does not mark decrypted items
 * `resolved`: `sent` is its only success write, so the intermediate mark would
 * be a wasted write per recipient.
 *
 * Never logs PII — the per-recipient trace carries the item id and status only,
 * never the resolved address. Belongs to `@aggregator-dpg/worker`.
 */
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
  unknownPlaceholders,
  type ContactField,
} from '@aggregator-dpg/campaign-template';
import { emailContentSchema, type EmailContent } from '@aggregator-dpg/campaign-template/content';
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

  const content = await resolveStoredContent(job, deps, base);
  if (!content) return;

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

  const rows = await decryptEmailItems(
    job,
    deps,
    email,
    content,
    open.map((i) => i.itemId),
  );
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
      // A long batch at bounded concurrency can otherwise exceed
      // CAMPAIGN_STALL_SECONDS while emails are actively going out, and the
      // watchdog would flag a healthy job `stalled` mid-flight.
      heartbeat: () => deps.client.heartbeat(job.id),
      log: deps.log,
    },
  );
  await deps.client.heartbeat(job.id);

  // A transient send error is NOT written terminal while attempts remain:
  // marking it `failed` on attempt 1 would lose that recipient to a one-second
  // transport blip, since `failed` is terminal and the retry skips it. Throwing
  // instead re-runs the job for exactly the items still open — recipients
  // already `sent` are excluded by the terminal guard above.
  await settleTransientFailures(job, deps, base, summary, start);

  const failed = summary.failed + summary.transient.length;
  deps.log.info({
    ...base,
    status: failed > 0 ? 'partial' : 'success',
    latency_ms: Date.now() - start,
    sent: summary.sent,
    skipped_no_contact: summary.skippedNoContact,
    failed,
  });
}

/**
 * Re-validates the `content` block persisted on the job row.
 *
 * The row outlives the request that wrote it, so this re-asserts exactly what
 * the API asserted at submit — the shared schema plus the placeholder
 * allow-list. A failure here is deterministic (a retry would fail identically),
 * so every still-actionable item is recorded `failed` and the job rolls up
 * terminal instead of being left `processing` for the watchdog.
 *
 * @param job - The job being processed.
 * @param deps - Injected client + logger.
 * @param base - Shared log fields for this job.
 * @returns The validated content, or `null` when the row is unusable (items
 *   have already been failed by then).
 */
async function resolveStoredContent(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  base: Record<string, unknown>,
): Promise<EmailContent | null> {
  const parsed = emailContentSchema.safeParse(job.content);
  const unknownTokens = parsed.success
    ? unknownPlaceholders(parsed.data.subject, parsed.data.body_markdown)
    : [];
  if (parsed.success && unknownTokens.length === 0) return parsed.data;

  deps.log.error({
    ...base,
    status: 'failure',
    step: 'content',
    reason: 'invalid_email_content',
    error: parsed.success
      ? `unknown_placeholders:${unknownTokens.join(',')}`
      : parsed.error.issues.map((i) => i.path.join('.')).join(','),
  });
  for (const item of job.items) {
    if (!TERMINAL_ITEM_STATUSES.includes(item.status)) {
      await deps.client.markItem(job.id, item.itemId, 'failed', 'invalid_email_content');
    }
  }
  return null;
}

/**
 * Decides what a transient send failure means for this attempt.
 *
 * While attempts remain it throws, so BullMQ re-runs the job for exactly the
 * recipients still open — recipients already `sent` are terminal and excluded.
 * Writing `failed` instead would be terminal, losing a recipient to a
 * one-second transport blip.
 *
 * An unknown retry position is treated as the LAST attempt — the opposite of
 * the job-level guard in `index.ts`, deliberately: marking a job terminal early
 * abandons work, whereas NOT recording a per-item outcome strands that item
 * `pending` with no reason. The job processor always injects `attempt`, so this
 * only bites a caller that forgot to.
 *
 * @param job - The job being processed.
 * @param deps - Injected client, logger and retry position.
 * @param base - Shared log fields for this job.
 * @param summary - The send loop's outcome tally.
 * @param start - Job start timestamp, for the latency field.
 * @throws {Error} When transient failures remain and attempts are left.
 */
async function settleTransientFailures(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  base: Record<string, unknown>,
  summary: EmailSendSummary,
  start: number,
): Promise<void> {
  if (summary.transient.length === 0) return;

  const attempt = deps.attempt;
  const isFinalAttempt = attempt === undefined || attempt.attempt >= attempt.maxAttempts;
  if (!isFinalAttempt) {
    deps.log.warn({
      ...base,
      status: 'failure',
      reason: 'transient_send_errors',
      latency_ms: Date.now() - start,
      sent: summary.sent,
      transient: summary.transient.length,
      attempt: attempt?.attempt,
      max_attempts: attempt?.maxAttempts,
    });
    throw new Error(
      `campaign email: ${summary.transient.length} recipient(s) failed transiently, retrying the job`,
    );
  }

  // Out of attempts: record them terminally with the typed code so the caller
  // sees a reason instead of a stranded item.
  for (const t of summary.transient) {
    await deps.client.markItem(job.id, t.itemId, 'failed', t.code);
  }
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
 * @param openItemIds - The job's still-open item ids, decided by the caller.
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
  content: EmailContent,
  openItemIds: string[],
): Promise<SignalStackDecryptedProfileRow[]> {
  const contact: ContactField[] = [
    ...new Set<ContactField>([
      'email',
      ...requiredContactFields(content.subject, content.body_markdown),
    ]),
  ];
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

    // Every requested id must come back in exactly one of the two lists. An id
    // in neither would otherwise stay `pending` forever: the job never rolls up
    // terminal, and ~15 min later the watchdog stamps a generic `stalled` with
    // no per-item reason. Account for it explicitly instead.
    const accounted = new Set([...profiles.map((p) => p.item_id), ...skipped]);
    for (const id of chunk) {
      if (!accounted.has(id)) {
        await deps.client.markItem(job.id, id, 'failed', 'decrypt_missing');
      }
    }

    await deps.client.heartbeat(job.id);
  }
  return resolvedRows;
}

/** Per-recipient outcome the caller persists as the item's terminal status. */
export type EmailRecipientStatus = 'sent' | 'skipped_no_contact' | 'failed';

/**
 * Mailer error codes that will never succeed for this recipient however many
 * times we try — the address itself is the problem. Everything else (transport,
 * auth) is treated as transient and left for the job's next attempt.
 */
const PERMANENT_SEND_ERRORS: ReadonlySet<string> = new Set(['INVALID_RECIPIENT']);

/** How many recipients to send between watchdog heartbeats inside the loop. */
const HEARTBEAT_EVERY = 25;

/** Injected collaborators — narrow types so the loop is trivially faked. */
export interface EmailSendDeps {
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
  /** How many recipients to send in parallel (`EMAIL_SEND_CONCURRENCY`). */
  concurrency: number;
  /** Beats the job's watchdog heartbeat periodically during a long batch. */
  heartbeat?: () => Promise<void>;
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
  /** Recipients whose failure is terminal — the address will never work. */
  failed: number;
  /**
   * Recipients whose send failed transiently. Deliberately NOT written to the
   * item row here: the caller decides, from the job's retry position, whether
   * to retry the job or record them `failed`.
   */
  transient: Array<{ itemId: string; code: string }>;
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
  const summary: EmailSendSummary = { sent: 0, skippedNoContact: 0, failed: 0, transient: [] };
  let done = 0;

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
      let rendered;
      try {
        rendered = renderEmail({
          subject: template.subject,
          bodyMarkdown: template.bodyMarkdown,
          values,
        });
      } catch {
        // Deterministic: the same template will fail the same way on a retry,
        // so record it terminally rather than burning every attempt. The
        // exception itself is not persisted — it can quote the template.
        summary.failed += 1;
        status = 'failed';
        await deps.markRecipient(profile.item_id, status, { reason: 'render_failed' });
        deps.log.info({ operation: 'campaign.email.recipient', item_id: profile.item_id, status });
        return;
      }

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
      } else if (PERMANENT_SEND_ERRORS.has(res.error.code)) {
        // Only the typed code is persisted. The provider's message routinely
        // quotes the rejected address (`550 5.1.1 <someone@example.com> ...`),
        // and this reason is returned by the poll API, which must never carry
        // a recipient address.
        summary.failed += 1;
        status = 'failed';
        await deps.markRecipient(profile.item_id, status, { reason: res.error.code });
      } else {
        // Transient: leave the item open and let the caller decide (see
        // EmailSendSummary.transient).
        summary.transient.push({ itemId: profile.item_id, code: res.error.code });
        status = 'failed';
      }
    }

    // Per-recipient trace — item_id + status only, never the resolved email
    // and never the provider's message.
    deps.log.info({ operation: 'campaign.email.recipient', item_id: profile.item_id, status });

    done += 1;
    if (deps.heartbeat && done % HEARTBEAT_EVERY === 0) await deps.heartbeat();
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
