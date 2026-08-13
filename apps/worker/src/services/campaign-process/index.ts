/**
 * Unified campaign-process orchestrator (aggregator-dpg#579).
 *
 * Runs one durable `campaign_job` end-to-end: loads the job + its items, guards
 * against re-running an already-terminal job (BullMQ retry safety), marks the
 * job `processing`, dispatches to the per-channel handler, writes per-item
 * terminal status as it goes, and rolls the job status up from the item counts.
 *
 * The export channel is implemented here (decrypt → CSV → private S3 → email a
 * short-lived pre-signed link). The email/voice channels are deliberate
 * not-implemented stubs — their PRs (#578/#577) fill them in on this same
 * engine.
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
import type { SignedDownloadUrl } from '../../object-storage.js';
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
    errorReason?: string,
  ): Promise<void>;
  heartbeat(jobId: string): Promise<void>;
  setJobStatus(jobId: string, status: CampaignJobStatus, errorReason?: string): Promise<void>;
  rollUpStatus(jobId: string): Promise<CampaignJobStatus>;
}

/** Export collaborators (decrypt/storage/mail) — narrow so the job is trivially faked. */
export interface ExportCollaborators {
  fetchDecryptedProfiles: (
    q: SignalStackFetchDecryptedProfilesQuery,
  ) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;
  putObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  signDownloadUrl: (key: string) => Promise<SignedDownloadUrl>;
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
}

export interface CampaignJobConfig {
  /** Items per decrypt chunk. */
  decryptChunk: number;
  /** `contact` = name/email/phone only; `full` = full item_state (variable columns). */
  fieldSet: 'contact' | 'full';
  /** Fixed recipient override; wins over the job's requested_by when set. */
  recipientOverride?: string;
  /** Last-resort recipient when the job has no requested_by. */
  adminEmailFallback?: string;
}

export interface CampaignJobDeps {
  client: CampaignJobClient;
  export: ExportCollaborators;
  config: CampaignJobConfig;
  log: CampaignLogger;
}

const TERMINAL_JOB: readonly CampaignJobStatus[] = ['succeeded', 'partially_failed', 'failed'];

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
  if (TERMINAL_JOB.includes(job.status)) {
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
    } else {
      // The email/voice PRs implement these on this same engine.
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

/** Runs the export channel for a job: chunked decrypt → item marks → CSV → S3 → email. */
async function runExportForJob(job: ProcessingJob, deps: CampaignJobDeps): Promise<void> {
  const contactOnly = deps.config.fieldSet === 'contact';
  const itemIds = job.items.map((i) => i.itemId);
  const resolvedRows: SignalStackDecryptedProfileRow[] = [];

  for (const chunk of chunkArray(itemIds, deps.config.decryptChunk)) {
    const query: SignalStackFetchDecryptedProfilesQuery = {
      actingOrgId: job.signalstackOrgId,
      itemIds: chunk,
      // contact-only projection: no item_state (fields:[]), just the canonical
      // contact fields with provenance (Signals #521). `full` omits `fields`.
      ...(contactOnly ? { fields: [], contact: ['name', 'email', 'phone'] } : {}),
      ...(job.requestId ? { requestId: job.requestId } : {}),
    };
    const result = await deps.export.fetchDecryptedProfiles(query);
    if (!result.success) {
      // Transient upstream failure — re-throw so BullMQ retries (items marked so
      // far persist; forward-only marks keep them on retry).
      throw new Error(
        `campaign export decrypt failed: ${result.error.code}: ${result.error.message}`,
      );
    }
    const { profiles, skipped } = result.value;

    // Cross-repo contract guard (Signals #521): a contact projection that comes
    // back with no contact block means an older Signals stripped it — fail loud
    // rather than ship an all-empty export.
    if (contactOnly && profiles.length > 0 && !profiles.some((p) => p.contact !== undefined)) {
      throw new Error(
        'campaign export decrypt returned no contact block — Signals participant/decrypt predates #521',
      );
    }

    for (const p of profiles) {
      resolvedRows.push(p);
      await deps.client.markItem(job.id, p.item_id, 'resolved');
    }
    for (const missing of skipped) {
      await deps.client.markItem(job.id, missing, 'failed', 'not_found_or_not_owned');
    }
    await deps.client.heartbeat(job.id);
  }

  const base = {
    operation: 'campaign.export',
    job_id: job.id,
    org_id: job.signalstackOrgId,
    requested: itemIds.length,
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
    deps.config.recipientOverride ?? job.requestedBy ?? deps.config.adminEmailFallback;
  if (!recipient) {
    throw new Error('campaign export has no recipient (no override, requested_by, or admin email)');
  }

  const email = renderExportEmail({
    orgId: job.signalstackOrgId,
    purpose: purposeOf(job) ?? '—',
    exported: resolvedRows.length,
    skipped: itemIds.length - resolvedRows.length,
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
