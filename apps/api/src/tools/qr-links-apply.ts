/**
 * Applies a checked QR links plan, in `@aggregator-dpg/api`.
 *
 * Creates one live two-option registration link per planned row through the
 * shared create service, owned and `created_by` the coordinator. A row an
 * earlier run loaded (`existing`) is reported, not created again. Stops at the
 * first failed row; a rerun with a fresh plan skips what is loaded.
 */

import type { FastifyBaseLogger } from 'fastify';
import { ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import { provisionedBy } from '../services/provisioned.js';
import { createRegistrationLink } from '../services/registration-links/create.js';
import { CallTimeout, withTimeout } from './call-timeout.js';
import type { InputProblem } from './qr-links-input.js';
import type { PlannedLink } from './qr-links-plan.js';

/** What happened to one row. */
export type LinkOutcome = 'created' | 'already_loaded' | 'failed' | 'not_run';

/** Error codes apply adds to the create service's codes. */
export const LINK_APPLY_ERROR = {
  /** The create call did not finish in time; the link may exist. A rerun finds it. */
  CALL_TIMEOUT: 'CALL_TIMEOUT',
  /** The create call threw. */
  UNEXPECTED: 'UNEXPECTED',
  /**
   * The row's `link_name` was taken after check, so create stored a suffixed slug.
   * That link exists; the log line has its slug so it can be retired.
   */
  LINK_NAME_TAKEN: 'LINK_NAME_TAKEN',
} as const;

/** One row of the operator's report. Holds the coordinator's email; never log it. */
export interface LinkReportRow {
  /** The links sheet line. */
  line: number;
  coordinatorEmail: string;
  profileType: string;
  /** The stored bot key; empty when no bot serves the profile type. */
  voiceBot: string;
  /** Empty unless the row is `created` or `already_loaded`. */
  slug: string;
  /** The public URL; empty unless the row is `created` or `already_loaded`. */
  url: string;
  outcome: LinkOutcome;
  /** A create-service or {@link LINK_APPLY_ERROR} code on a `failed` row; else empty. */
  errorCode: string;
}

/** The result of one create attempt. */
type CreateResult =
  { ok: true; slug: string; url: string; voiceBot: string } | { ok: false; code: string };

/**
 * Applies a plan that has no problems.
 *
 * Never throws once rows start: a create that throws fails its row with
 * UNEXPECTED, and one that times out with CALL_TIMEOUT.
 *
 * @param opts.operator - Who runs the load; logged as `provisioned:<operator>`.
 * @param opts.callTimeoutMs - Bound on each create call; none when absent.
 * @returns One report row per planned link, in sheet order, and whether a row failed.
 * @throws {ValidationError} When the plan has problems (`PLAN_HAS_PROBLEMS`) or the operator is invalid.
 */
export async function applyLinksPlan(
  plan: { links: PlannedLink[]; problems: InputProblem[] },
  opts: { operator: string; log: FastifyBaseLogger; callTimeoutMs?: number },
): Promise<{ rows: LinkReportRow[]; failed: boolean }> {
  if (plan.problems.length > 0) {
    throw new ValidationError('the links plan has problems; run check and fix them first', {
      code: 'PLAN_HAS_PROBLEMS',
    });
  }
  const operator = provisionedBy(opts.operator);
  const started = Date.now();
  const log = opts.log.child({ operation: 'qrLinks.apply', operator });

  const rows: LinkReportRow[] = [];
  let failedRow: LinkReportRow | null = null;
  for (const link of plan.links) {
    const report: LinkReportRow = {
      line: link.row.line,
      coordinatorEmail: link.row.coordinatorEmail.trim(),
      profileType: link.domain,
      voiceBot: link.voiceBotKey ?? '',
      slug: '',
      url: '',
      outcome: 'not_run',
      errorCode: '',
    };
    rows.push(report);
    if (failedRow) continue;
    if (link.existing) {
      report.outcome = 'already_loaded';
      report.slug = link.existing.slug;
      report.url = link.existing.url;
      report.voiceBot = link.existing.voiceBotKey ?? '';
    } else {
      const result = await create(link, log, opts.callTimeoutMs);
      if (result.ok) {
        report.outcome = 'created';
        report.slug = result.slug;
        report.url = result.url;
        report.voiceBot = result.voiceBot;
      } else {
        report.outcome = 'failed';
        report.errorCode = result.code;
        failedRow = report;
      }
    }
    log.info({
      status: report.outcome === 'failed' ? 'failure' : 'success',
      line: report.line,
      user_id: link.userId,
      outcome: report.outcome,
      slug: report.slug || undefined,
      error_code: report.errorCode || undefined,
    });
  }

  const byOutcome: Record<string, number> = {};
  for (const r of rows) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  log.info(
    {
      status: failedRow ? 'failure' : 'success',
      latency_ms: Date.now() - started,
      rows: rows.length,
      outcomes: byOutcome,
      ...(failedRow ? { failed_line: failedRow.line, error_code: failedRow.errorCode } : {}),
    },
    'qr-links apply finished',
  );
  return { rows, failed: failedRow !== null };
}

/** Creates one live two-option link, turning a throw or a timeout into a failed result. */
async function create(
  link: PlannedLink,
  log: FastifyBaseLogger,
  callTimeoutMs: number | undefined,
): Promise<CreateResult> {
  const call = createRegistrationLink({
    userId: link.userId,
    orgSlug: link.orgSlug,
    // The plan checked the coordinator serves this domain.
    servedDomains: [link.domain],
    domain: link.domain,
    registrationMode: link.registrationMode,
    voiceBotKey: link.voiceBotKey,
    ...(link.slug === undefined ? {} : { slug: link.slug }),
    status: 'live',
    expiresAt: link.expiresAt,
    createdBy: link.userId,
    log,
  });
  try {
    const result = await (callTimeoutMs === undefined
      ? call
      : withTimeout(call, callTimeoutMs, 'link create'));
    if (!result.ok) return { ok: false, code: result.error.code };
    const { link: stored, publicUrl } = result.value;
    if (link.slug !== undefined && stored.slug !== link.slug) {
      // A rerun could never find the suffixed link by its name, so the row fails here.
      log.warn({
        status: 'failure',
        line: link.row.line,
        user_id: link.userId,
        error_code: LINK_APPLY_ERROR.LINK_NAME_TAKEN,
        created_slug: stored.slug,
      });
      return { ok: false, code: LINK_APPLY_ERROR.LINK_NAME_TAKEN };
    }
    return {
      ok: true,
      slug: stored.slug,
      url: publicUrl ?? '',
      voiceBot: stored.voiceBotKey ?? '',
    };
  } catch (err: unknown) {
    const code =
      err instanceof CallTimeout ? LINK_APPLY_ERROR.CALL_TIMEOUT : LINK_APPLY_ERROR.UNEXPECTED;
    log.error({
      status: 'failure',
      line: link.row.line,
      error_code: code,
      error_type: err instanceof Error ? err.constructor.name : typeof err,
    });
    return { ok: false, code };
  }
}
