/**
 * Applies a checked org-loader plan, in `@aggregator-dpg/api`.
 *
 * Creates the orgs (parents first) and then the coordinators through the
 * shared registration services, approves each through the approval services
 * with `decidedBy = provisioned:<operator>`, and awaits one token-roles sync
 * per account. Writes no consent row and sends no mail. Stops at the first
 * failed row; a rerun with a fresh plan skips what is loaded and resumes
 * what an earlier run left pending.
 */

import type { FastifyBaseLogger } from 'fastify';
import { ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import { provisionedBy } from '../services/provisioned.js';
import { applyCoordinator } from './org-loader-apply-coordinators.js';
import { applyOrg } from './org-loader-apply-orgs.js';
import {
  APPLY_ERROR,
  type ApplyContext,
  type RowIds,
  type RowOutcome,
  type RowResult,
} from './org-loader-apply-shared.js';
import type { LoadPlan } from './org-loader-plan-shared.js';

export { APPLY_ERROR };
export type { RowOutcome };

/** One row of the operator's report. May hold name and email; never log it. */
export interface ReportRow extends RowIds {
  kind: 'org' | 'coordinator';
  /** The input file's line. */
  line: number;
  name: string;
  email: string;
  outcome: RowOutcome;
  /** An {@link APPLY_ERROR} or shared-service error code, on a `failed` row. */
  errorCode?: string;
}

/** One unit of work: its report row and the step that applies it. */
interface Step {
  report: ReportRow;
  run: (ctx: ApplyContext) => Promise<RowResult>;
}

/**
 * Applies a plan that has no problems.
 *
 * Never throws once rows start: a row whose step throws is `failed` with
 * code `UNEXPECTED`. Every row after the first failed one is `not_run`.
 *
 * @param opts.operator - Who runs the load; recorded as `provisioned:<operator>`.
 * @returns One report row per planned row, orgs then coordinators, and whether a row failed.
 * @throws {ValidationError} When the plan has problems (`PLAN_HAS_PROBLEMS`) or the operator is invalid.
 */
export async function applyLoadPlan(
  plan: LoadPlan,
  opts: { operator: string; log: FastifyBaseLogger },
): Promise<{ rows: ReportRow[]; failed: boolean }> {
  if (plan.problems.length > 0) {
    throw new ValidationError('the load plan has problems; run check and fix them first', {
      code: 'PLAN_HAS_PROBLEMS',
    });
  }
  const started = Date.now();
  const log = opts.log.child({ operation: 'orgLoader.apply' });
  const ctx: ApplyContext = {
    decidedBy: provisionedBy(opts.operator),
    log,
    orgIds: new Map(),
    ownerSubs: new Map(),
  };
  const steps: Step[] = [
    ...plan.orgs.map((p) => ({
      report: row('org', p.row.line, p.row.name, p.row.owner.email),
      run: (c: ApplyContext) => applyOrg(p, c),
    })),
    ...plan.coordinators.map((p) => ({
      report: row('coordinator', p.row.line, p.row.name, p.row.email),
      run: (c: ApplyContext) => applyCoordinator(p, c),
    })),
  ];

  let failedRow: ReportRow | null = null;
  for (const step of steps) {
    if (failedRow) break;
    const result = await runStep(step, ctx);
    const { report } = step;
    if (result.ok) {
      const { ok: _ok, ...rest } = result;
      Object.assign(report, rest);
    } else {
      report.outcome = 'failed';
      report.errorCode = result.code;
      failedRow = report;
    }
    log.info({
      status: result.ok ? 'success' : 'failure',
      kind: report.kind,
      line: report.line,
      outcome: report.outcome,
      org_id: report.orgId,
      user_id: report.userId,
      roles_sync: report.rolesSync,
      error_code: report.errorCode,
    });
  }

  const rows = steps.map((s) => s.report);
  const byOutcome: Record<string, number> = {};
  for (const r of rows) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  log.info(
    {
      status: failedRow ? 'failure' : 'success',
      latency_ms: Date.now() - started,
      rows: rows.length,
      outcomes: byOutcome,
      ...(failedRow
        ? {
            failed_kind: failedRow.kind,
            failed_line: failedRow.line,
            error_code: failedRow.errorCode,
          }
        : {}),
    },
    'org-loader apply finished',
  );
  return { rows, failed: failedRow !== null };
}

/** A report row that has not run yet. */
function row(kind: ReportRow['kind'], line: number, name: string, email: string): ReportRow {
  return { kind, line, name, email, outcome: 'not_run' };
}

/** Runs one step, turning a thrown error into a failed result. */
async function runStep(step: Step, ctx: ApplyContext): Promise<RowResult> {
  try {
    return await step.run(ctx);
  } catch (err: unknown) {
    ctx.log.error({
      status: 'failure',
      kind: step.report.kind,
      line: step.report.line,
      error_type: err instanceof Error ? err.constructor.name : typeof err,
    });
    return { ok: false, code: APPLY_ERROR.UNEXPECTED };
  }
}
