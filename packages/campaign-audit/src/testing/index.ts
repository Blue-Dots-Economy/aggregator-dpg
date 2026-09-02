/**
 * In-memory audit writer for tests, plus input builders.
 *
 * Exposes the rows it captured so tests can assert on them — that read is a
 * TEST affordance only. The production interface stays write-only.
 *
 * @module @aggregator-dpg/campaign-audit/testing
 */
import { ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  CampaignAuditWriterBase,
  type RequestedAuditInput,
  type CompletedAuditInput,
  type DumpAuditInput,
} from '../interface.js';

/** One captured row, tagged with which method produced it. */
export type AuditRow =
  | ({ kind: 'requested' } & RequestedAuditInput)
  | ({ kind: 'completed' } & CompletedAuditInput)
  | ({ kind: 'dump' } & DumpAuditInput);

/**
 * In-memory {@link CampaignAuditWriterBase} for unit tests.
 *
 * Captures every accepted row (tagged by kind) in `rows` and, when
 * `failWith` is set, THROWS that error from every method instead of
 * returning `err(...)` — this is deliberate: it lets Tasks 5-7 prove their
 * call sites survive an audit writer that throws, the harsher failure mode.
 */
export class CampaignAuditWriterFake extends CampaignAuditWriterBase {
  /** Rows captured so far, in call order. TEST-ONLY read affordance. */
  readonly rows: AuditRow[] = [];
  /** When set, every method throws this instead of writing a row. */
  failWith: Error | null = null;

  override async recordRequested(input: RequestedAuditInput): Promise<Result<void, BaseError>> {
    if (this.failWith) throw this.failWith;
    this.rows.push({ kind: 'requested', ...input });
    return ok(undefined);
  }

  override async recordCompleted(input: CompletedAuditInput): Promise<Result<void, BaseError>> {
    if (this.failWith) throw this.failWith;
    this.rows.push({ kind: 'completed', ...input });
    return ok(undefined);
  }

  override async recordDumpAccess(input: DumpAuditInput): Promise<Result<void, BaseError>> {
    if (this.failWith) throw this.failWith;
    this.rows.push({ kind: 'dump', ...input });
    return ok(undefined);
  }

  /** Clears captured rows and the `failWith` override, for test isolation. */
  reset(): void {
    this.rows.length = 0;
    this.failWith = null;
  }
}

/**
 * Builds a valid `requested` input. Defaults are deterministic (fixed uuid,
 * fixed date, operator identities only) so tests are reproducible and never
 * carry a participant PII value.
 *
 * @param over - Fields to override on top of the defaults.
 * @returns A complete {@link RequestedAuditInput}.
 */
export function buildRequestedAudit(over: Partial<RequestedAuditInput> = {}): RequestedAuditInput {
  return {
    correlationId: '00000000-0000-4000-8000-000000000001',
    channel: 'export',
    actorUserId: 'kc-sub-1',
    actorOrgId: 'org_test',
    actorAzp: 'campaign-manager',
    piiFields: ['name', 'email', 'phone'],
    itemCount: 3,
    requestedAt: new Date('2026-09-02T10:00:00.000Z'),
    endpoint: 'POST /v1/campaign/export',
    ...over,
  };
}

/**
 * Builds a valid `completed` input. Defaults are deterministic and contain
 * NO participant PII — only operator/field-name identifiers and counts.
 *
 * @param over - Fields to override on top of the defaults.
 * @returns A complete {@link CompletedAuditInput}.
 */
export function buildCompletedAudit(over: Partial<CompletedAuditInput> = {}): CompletedAuditInput {
  return {
    correlationId: '00000000-0000-4000-8000-000000000001',
    channel: 'export',
    actorOrgId: 'org_test',
    outcome: 'succeeded',
    completedAt: new Date('2026-09-02T10:00:05.000Z'),
    resolvedCount: 3,
    skippedCount: 0,
    failedCount: 0,
    ...over,
  };
}

/**
 * Builds a valid `dump` input. Defaults are deterministic and contain NO
 * participant PII — `details` carries only non-PII counts.
 *
 * @param over - Fields to override on top of the defaults.
 * @returns A complete {@link DumpAuditInput}.
 */
export function buildDumpAudit(over: Partial<DumpAuditInput> = {}): DumpAuditInput {
  return {
    correlationId: '00000000-0000-4000-8000-000000000009',
    actorUserId: 'service-account-campaign-manager',
    actorAzp: 'campaign-manager',
    outcome: 'succeeded',
    completedAt: new Date('2026-09-02T10:00:00.000Z'),
    endpoint: 'GET /v1/campaign/dump',
    details: { files: 3, bytes: 1024 },
    ...over,
  };
}
