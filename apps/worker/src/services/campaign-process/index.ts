/**
 * Unified campaign-process orchestrator (aggregator-dpg#579).
 *
 * Runs one durable `campaign_job` end-to-end: loads the job + its items, guards
 * against re-running an already-terminal job (BullMQ retry safety), marks the
 * job `processing`, dispatches to the per-channel handler, writes per-item
 * terminal status as it goes, and rolls the job status up from the item counts.
 *
 * Two channels are implemented here: export (decrypt → CSV → private S3 →
 * email a short-lived pre-signed link) and email (#578: decrypt → render the
 * Markdown template → per-recipient send, item status per recipient). Voice
 * (#577) is a deliberate not-implemented stub on this same engine.
 *
 * Failure semantics: a transient/infra failure (decrypt err(), the #521
 * contact-block guard, an S3 or mail rejection) re-throws so BullMQ retries and
 * the job is left `processing` — never falsely marked terminal. Per-item
 * "not found / not owned" is a terminal item failure (not a job failure); the
 * roll-up turns a mix into `partially_failed`. Never logs PII.
 * Belongs to `@aggregator-dpg/worker`.
 */
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type {
  SignalStackFetchDecryptedProfilesQuery,
  SignalStackDecryptedProfiles,
  SignalStackDecryptedProfileRow,
} from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import { buildContactExportCsv, buildDecryptedProfilesCsv } from '@aggregator-dpg/profile-csv';
import { requiredContactFields, type ContactField } from '@aggregator-dpg/campaign-template';
import { z } from 'zod';
import type { SignedDownloadUrl } from '../../object-storage.js';
import { TERMINAL_ITEM_STATUSES, TERMINAL_JOB_STATUSES } from '../campaign-job-client.js';
import { sendCampaignEmails } from './email.js';
import type {
  CampaignJobItemStatus,
  CampaignJobStatus,
  ProcessingJob,
} from '../campaign-job-client.js';

/** Minimal structured logger surface (satisfied by the worker's pino child). */
export interface CampaignLogger {
  info(obj: object): void;
  warn(obj: object): void;
  error(obj: object): void;
}

/** The subset of the job-client the orchestrator writes through. */
export interface CampaignJobClient {
  getJobForProcessing(jobId: string): Promise<ProcessingJob | null>;
  markItem(
    jobId: string,
    itemId: string,
    status: CampaignJobItemStatus,
    reason?: string,
    providerRef?: string,
  ): Promise<void>;
  heartbeat(jobId: string): Promise<void>;
  setJobStatus(jobId: string, status: CampaignJobStatus, errorReason?: string): Promise<void>;
  rollUpStatus(jobId: string): Promise<CampaignJobStatus>;
}

/** Signals decrypt — the one collaborator every channel needs. */
export type FetchDecryptedProfiles = (
  q: SignalStackFetchDecryptedProfilesQuery,
) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;

/** Export-only collaborators (storage + the link notification). */
export interface ExportCollaborators {
  putObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  signDownloadUrl: (key: string) => Promise<SignedDownloadUrl>;
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
}

/** Email-only collaborators (the participant-facing mailer). */
export interface EmailCollaborators {
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
}

export interface CampaignJobConfig {
  /** Items per decrypt chunk. */
  decryptChunk: number;
  /** `contact` = name/email/phone only; `full` = full item_state (variable columns). */
  fieldSet: 'contact' | 'full';
  /**
   * Who gets the export link: `requester` (the job's `requested_by`) or
   * `network_admin` (`networkAdminEmail`). Deployment-level, never caller-set.
   */
  recipientMode: 'requester' | 'network_admin';
  /** Recipient used when `recipientMode` is `network_admin`. */
  networkAdminEmail?: string;
  /** Recipients emailed in parallel per email job (`EMAIL_SEND_CONCURRENCY`). */
  emailSendConcurrency: number;
}

export interface CampaignJobDeps {
  client: CampaignJobClient;
  /** Shared by every channel — each one starts from an ownership-scoped decrypt. */
  fetchDecryptedProfiles: FetchDecryptedProfiles;
  export: ExportCollaborators;
  email: EmailCollaborators;
  config: CampaignJobConfig;
  log: CampaignLogger;
}

const TERMINAL_JOB = new Set<CampaignJobStatus>(TERMINAL_JOB_STATUSES);
const TERMINAL_ITEM = new Set<CampaignJobItemStatus>(TERMINAL_ITEM_STATUSES);

/**
 * Runs one campaign job by id.
 *
 * @param jobId - The `campaign_job.id` to process (trusted — from the queue).
 * @param deps - Injected job-client, export collaborators, config, logger.
 */
export async function runCampaignJob(jobId: string, deps: CampaignJobDeps): Promise<void> {
  const job = await deps.client.getJobForProcessing(jobId);
  if (!job) {
    deps.log.warn({
      operation: 'campaign.process',
      status: 'skipped',
      reason: 'job_not_found',
      job_id: jobId,
    });
    return;
  }
  // Retry guard: a job that already reached a terminal status is not re-run.
  if (TERMINAL_JOB.has(job.status)) {
    deps.log.info({
      operation: 'campaign.process',
      status: 'skipped',
      reason: 'already_terminal',
      job_id: jobId,
      job_status: job.status,
    });
    return;
  }

  await deps.client.setJobStatus(jobId, 'processing');

  try {
    if (job.channel === 'export') {
      await runExportForJob(job, deps);
    } else if (job.channel === 'email') {
      await runEmailForJob(job, deps);
    } else {
      // The voice PR (#577) implements its channel on this same engine.
      throw new Error(`campaign channel not implemented: ${job.channel}`);
    }
    const status = await deps.client.rollUpStatus(jobId);
    deps.log.info({
      operation: 'campaign.process',
      status: 'success',
      job_id: jobId,
      channel: job.channel,
      job_status: status,
    });
  } catch (err) {
    // Leave the job `processing` so BullMQ retries; never mark terminal here.
    deps.log.error({
      operation: 'campaign.process',
      status: 'failure',
      job_id: jobId,
      channel: job.channel,
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.constructor.name : 'unknown',
    });
    throw err;
  }
}

/** Per-call decrypt options — the channels differ in projection and marking. */
interface DecryptOptions {
  /** Item ids to decrypt (the caller filters out anything already terminal). */
  itemIds: string[];
  /**
   * Contact projection to request, or `null` for the `full` export projection
   * (whole `item_state`, no contact block).
   */
  contact: ContactField[] | null;
  /**
   * Mark every decrypted item `resolved`. True for export, whose success
   * terminal IS "decrypted into the CSV"; false for email, which acts after the
   * decrypt and writes `sent`/`failed` per recipient instead.
   */
  markResolved: boolean;
}

/**
 * Decrypts the requested items in chunks, marking unowned ids
 * `skipped_not_owned` (and resolved ones `resolved` when asked) while beating
 * the heartbeat per chunk. Re-throws on a transient decrypt failure or the #521
 * contact-block guard (so BullMQ retries). Returns the resolved profile rows.
 */
async function decryptAndMarkItems(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  options: DecryptOptions,
): Promise<SignalStackDecryptedProfileRow[]> {
  const resolvedRows: SignalStackDecryptedProfileRow[] = [];
  const contactOnly = options.contact !== null;

  for (const chunk of chunkArray(options.itemIds, deps.config.decryptChunk)) {
    const query: SignalStackFetchDecryptedProfilesQuery = {
      actingOrgId: job.signalstackOrgId,
      itemIds: chunk,
      // contact-only projection: no item_state (fields:[]), just the contact
      // fields this channel needs, with provenance (Signals #521). The `full`
      // export projection omits both keys.
      ...(options.contact ? { fields: [], contact: options.contact } : {}),
      ...(job.requestId ? { requestId: job.requestId } : {}),
    };
    const result = await deps.fetchDecryptedProfiles(query);
    if (!result.success) {
      // Transient upstream failure — re-throw so BullMQ retries (items marked so
      // far persist; forward-only marks keep them on retry).
      throw new Error(
        `campaign ${job.channel} decrypt failed: ${result.error.code}: ${result.error.message}`,
      );
    }
    const { profiles, skipped } = result.value;

    // Cross-repo contract guard (Signals #521): a contact projection that comes
    // back with no contact block means an older Signals stripped it — fail loud
    // rather than ship an all-empty export or email every recipient as
    // address-less.
    if (contactOnly && profiles.length > 0 && !profiles.some((p) => p.contact !== undefined)) {
      throw new Error(
        `campaign ${job.channel} decrypt returned no contact block — Signals participant/decrypt predates #521`,
      );
    }

    for (const p of profiles) {
      resolvedRows.push(p);
      if (options.markResolved) await deps.client.markItem(job.id, p.item_id, 'resolved');
    }
    for (const missing of skipped) {
      // Not a failure: the org simply doesn't own this item, so it is skipped
      // (and never leaked). Skips don't make the job `partial`.
      await deps.client.markItem(job.id, missing, 'skipped_not_owned', 'not_owned_by_org');
    }
    await deps.client.heartbeat(job.id);
  }
  return resolvedRows;
}

/**
 * The email channel's `content` block, as persisted on the job row. Re-validated
 * here rather than trusted: the row outlives the request that wrote it, and a
 * malformed template must fail the job's items deterministically instead of
 * rendering something unintended into a participant's inbox.
 */
const emailContentSchema = z.object({
  subject: z.string().min(1),
  body_markdown: z.string().min(1),
  reply_to: z.string().optional(),
});

/**
 * Runs the email channel for a job: decrypt the still-pending recipients →
 * render the submitted template → send per recipient → per-item terminal status.
 *
 * Retry-safe by construction: only items that are NOT already terminal are
 * decrypted and sent, so a BullMQ retry (attempts: CAMPAIGN_EMAIL_ATTEMPTS)
 * re-sends to nobody already marked `sent`. That is what buys durability
 * without the `attempts: 1` compromise.
 */
async function runEmailForJob(job: ProcessingJob, deps: CampaignJobDeps): Promise<void> {
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
      if (!TERMINAL_ITEM.has(item.status)) {
        await deps.client.markItem(job.id, item.itemId, 'failed', 'invalid_email_content');
      }
    }
    return;
  }
  const content = parsed.data;

  // Retry guard: an item already `sent` (or skipped/failed) is terminal — never
  // decrypt it again, never email it again.
  const pending = job.items.filter((i) => !TERMINAL_ITEM.has(i.status));
  if (pending.length === 0) {
    deps.log.info({
      ...base,
      status: 'skipped',
      reason: 'all_items_terminal',
      latency_ms: Date.now() - start,
    });
    return;
  }

  // Decrypt only what the template needs: the recipient email is always
  // required; name/phone only when a placeholder references them.
  const contact: ContactField[] = [
    ...new Set<ContactField>([
      'email',
      ...requiredContactFields(content.subject, content.body_markdown),
    ]),
  ];
  const rows = await decryptAndMarkItems(job, deps, {
    itemIds: pending.map((i) => i.itemId),
    contact,
    // `sent` is the email channel's only success write (per recipient, below),
    // so the intermediate `resolved` mark would be a wasted write per item.
    markResolved: false,
  });

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
      sendMail: deps.email.sendMail,
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

/** Runs the export channel for a job: chunked decrypt → item marks → CSV → S3 → email. */
async function runExportForJob(job: ProcessingJob, deps: CampaignJobDeps): Promise<void> {
  const contactOnly = deps.config.fieldSet === 'contact';
  const resolvedRows = await decryptAndMarkItems(job, deps, {
    itemIds: job.items.map((i) => i.itemId),
    contact: contactOnly ? ['name', 'email', 'phone'] : null,
    markResolved: true,
  });

  const base = {
    operation: 'campaign.export',
    job_id: job.id,
    org_id: job.signalstackOrgId,
    requested: job.items.length,
  };

  if (resolvedRows.length === 0) {
    // Nothing owned to export — every item was marked failed above; the roll-up
    // makes the job `failed`. No upload, no email. Counts only, never PII.
    deps.log.warn({ ...base, status: 'skipped', reason: 'no_resolvable_items', exported: 0 });
    return;
  }

  const csv = contactOnly
    ? buildContactExportCsv(resolvedRows)
    : buildDecryptedProfilesCsv(resolvedRows);
  const key = `campaign-exports/${job.signalstackOrgId}/${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  await deps.export.putObject(key, Buffer.from(csv, 'utf8'), 'text/csv');
  const signed = await deps.export.signDownloadUrl(key);

  const recipient =
    deps.config.recipientMode === 'network_admin' ? deps.config.networkAdminEmail : job.requestedBy;
  if (!recipient) {
    throw new Error(
      `campaign export has no recipient for mode "${deps.config.recipientMode}" ` +
        '(set EXPORT_NETWORK_ADMIN_EMAIL, or use CAMPAIGN_EXPORT_RECIPIENT=requester)',
    );
  }

  const email = renderExportEmail({
    orgId: job.signalstackOrgId,
    purpose: purposeOf(job) ?? '—',
    exported: resolvedRows.length,
    skipped: job.items.length - resolvedRows.length,
    url: signed.url,
    expiresAt: signed.expiresAt,
  });
  const sent = await deps.export.sendMail({
    to: recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  if (!sent.ok) {
    // CSV is durably in S3; re-throw so BullMQ re-sends (re-decrypt + re-upload).
    throw new Error(`campaign export email failed: ${sent.error.code}: ${sent.error.message}`);
  }

  deps.log.info({ ...base, status: 'success', exported: resolvedRows.length, s3_key: key });
}

/** Reads the `purpose` metadata pair off a job, if present. */
function purposeOf(job: ProcessingJob): string | undefined {
  const p = job.metadata.find((m) => m.key === 'purpose')?.value;
  return p?.trim() ? p : undefined;
}

/** Splits an array into fixed-size chunks (never empty; last chunk may be short). */
function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface ExportEmailInput {
  orgId: string;
  purpose: string;
  exported: number;
  skipped: number;
  url: string;
  expiresAt: string;
}

/** Escapes the few HTML metacharacters that can appear in org id / purpose. */
function esc(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Formats an ISO-8601 expiry timestamp for a human reader, in UTC — e.g.
 * `2026-08-13T06:13:34.191Z` → `13 Aug 2026, 06:13 UTC`. Falls back to the raw
 * value if it can't be parsed.
 */
function formatExpiry(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  const formatted = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(when);
  return `${formatted} UTC`;
}

/** Renders the export-ready notification (link only — never the PII itself). */
function renderExportEmail(i: ExportEmailInput): { subject: string; html: string; text: string } {
  const subject = `PII export ready — ${i.exported} records`;
  const text = [
    'A participant PII export is ready.',
    '',
    `Requested by org: ${i.orgId}`,
    `Purpose: ${i.purpose}`,
    `Records exported: ${i.exported}`,
    `Skipped (not found / not owned): ${i.skipped}`,
    '',
    `Download it before ${formatExpiry(i.expiresAt)}:`,
    i.url,
    '',
    'After that the link stops working and the file is permanently deleted from storage — so download it now. The file contains personal data; do not forward this link.',
  ].join('\n');
  const html = [
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.5">',
    '<p>A participant PII export is ready.</p>',
    '<ul>',
    `<li>Requested by org: <strong>${esc(i.orgId)}</strong></li>`,
    `<li>Purpose: ${esc(i.purpose)}</li>`,
    `<li>Records exported: <strong>${i.exported}</strong></li>`,
    `<li>Skipped (not found / not owned): <strong>${i.skipped}</strong></li>`,
    '</ul>',
    `<p><a href="${esc(i.url)}">Download the export</a> before <strong>${formatExpiry(i.expiresAt)}</strong>.</p>`,
    '<p style="color:#a00">After that the link stops working and the file is <strong>permanently deleted</strong> from storage — so download it now. The file contains personal data; do not forward this link.</p>',
    '</div>',
  ].join('');
  return { subject, html, text };
}
