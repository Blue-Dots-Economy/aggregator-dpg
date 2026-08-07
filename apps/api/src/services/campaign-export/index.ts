/**
 * Participant PII export orchestrator (interim, aggregator-dpg#579).
 *
 * Decrypts a set of owned Signals items, writes a CSV to private S3, and emails
 * a short-lived pre-signed download link to the configured network admin. Runs
 * fire-and-forget from the route: it NEVER throws and NEVER logs PII — every
 * failure branch logs counts only and returns. Belongs to `@aggregator-dpg/api`.
 */
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type {
  SignalStackFetchDecryptedProfilesQuery,
  SignalStackDecryptedProfiles,
} from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '../mailer/interface.js';
import type { SignedDownloadUrl } from '../object-storage/index.js';
import { buildDecryptedProfilesCsv } from '../profile-csv.js';

/** Request-scoped inputs resolved from the route body + `x-org-id` header. */
export interface ExportParams {
  orgId: string;
  itemIds: string[];
  purpose?: string;
}

/** Minimal structured logger surface (satisfied by `req.log.child(...)`). */
export interface ExportLogger {
  info(obj: object): void;
  warn(obj: object): void;
  error(obj: object): void;
}

/** Injected collaborators — narrow function types so the job is trivially faked. */
export interface ExportDeps {
  fetchDecryptedProfiles: (
    q: SignalStackFetchDecryptedProfilesQuery,
  ) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;
  putObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  signDownloadUrl: (key: string) => Promise<SignedDownloadUrl>;
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
  networkAdminEmail: string;
  log: ExportLogger;
}

interface ExportEmailInput {
  orgId: string;
  purpose: string;
  domain: string;
  exported: number;
  skipped: number;
  url: string;
  expiresAt: string;
}

/** Escapes the few HTML metacharacters that can appear in org id / purpose. */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Renders the network-admin notification (link only — never the PII itself). */
function renderExportEmail(i: ExportEmailInput): { subject: string; html: string; text: string } {
  const subject = `PII export ready — ${i.domain} (${i.exported} records)`;
  const text = [
    'A participant PII export is ready.',
    '',
    `Requested by org: ${i.orgId}`,
    `Purpose: ${i.purpose}`,
    `Records exported: ${i.exported}`,
    `Skipped (not found / not owned): ${i.skipped}`,
    '',
    `Download (expires ${i.expiresAt}):`,
    i.url,
    '',
    'This link is time-limited and the file contains personal data. Do not forward it.',
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
    `<p><a href="${esc(i.url)}">Download the export</a> (expires ${esc(i.expiresAt)}).</p>`,
    '<p style="color:#a00">This link is time-limited and the file contains personal data. Do not forward it.</p>',
    '</div>',
  ].join('');
  return { subject, html, text };
}

/**
 * Runs one export end-to-end. Fire-and-forget: awaited only in tests.
 *
 * @param params - orgId (Signals org id), itemIds, optional purpose.
 * @param deps - Injected decrypt / storage / mail collaborators + admin email + logger.
 */
export async function runExport(params: ExportParams, deps: ExportDeps): Promise<void> {
  const { orgId, itemIds, purpose } = params;
  const start = Date.now();
  const base = { operation: 'campaign.export', org_id: orgId, requested: itemIds.length };

  const result = await deps.fetchDecryptedProfiles({ actingOrgId: orgId, itemIds });
  if (!result.success) {
    deps.log.error({
      ...base,
      status: 'failure',
      step: 'decrypt',
      latency_ms: Date.now() - start,
      error: result.error.message,
      error_type: result.error.code,
    });
    return;
  }

  const { profiles, skipped } = result.value;

  if (profiles.length === 0) {
    deps.log.warn({
      ...base,
      status: 'skipped',
      reason: 'no_resolvable_items',
      latency_ms: Date.now() - start,
      exported: 0,
      skipped: skipped.length,
    });
    return;
  }

  const distinct = new Set(profiles.map((p) => `${p.item_domain}/${p.item_type}`));
  if (distinct.size > 1) {
    deps.log.error({
      ...base,
      status: 'failure',
      step: 'validate',
      latency_ms: Date.now() - start,
      error: 'mixed item_type/domain in export request',
      error_type: 'MIXED_ITEM_TYPES',
      distinct: [...distinct],
    });
    return;
  }

  const domain = profiles[0]!.item_domain;
  const csv = buildDecryptedProfilesCsv(profiles);
  const key = `campaign-exports/${orgId}/${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

  await deps.putObject(key, Buffer.from(csv, 'utf8'), 'text/csv');
  const signed = await deps.signDownloadUrl(key);

  const email = renderExportEmail({
    orgId,
    purpose: purpose && purpose.trim() ? purpose : '—',
    domain,
    exported: profiles.length,
    skipped: skipped.length,
    url: signed.url,
    expiresAt: signed.expiresAt,
  });

  const sent = await deps.sendMail({
    to: deps.networkAdminEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  if (!sent.ok) {
    deps.log.error({
      ...base,
      status: 'failure',
      step: 'email',
      latency_ms: Date.now() - start,
      error: sent.error.message,
      error_type: sent.error.code,
      s3_key: key,
    });
    return;
  }

  deps.log.info({
    ...base,
    status: 'success',
    latency_ms: Date.now() - start,
    exported: profiles.length,
    skipped: skipped.length,
    s3_key: key,
  });
}
