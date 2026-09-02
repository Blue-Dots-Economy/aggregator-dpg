/**
 * Campaign PII-action audit writer (#617).
 *
 * WRITE-ONLY BY DESIGN. There is no update, no delete, and no read on this
 * surface — that absence IS the append-only guarantee. A caller cannot rewrite
 * history because the vocabulary to do so does not exist. Do not add a read
 * method "for convenience": compliance queries the table directly.
 *
 * NEVER pass a participant PII value into any of these inputs. Field NAMES and
 * counts only; `recipientRef` is an operator address, never a participant's.
 *
 * @module @aggregator-dpg/campaign-audit
 */
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

/** The audited action. Wider than the campaign channels — the dump is audited too. */
export type AuditChannel = 'export' | 'email' | 'voice' | 'dump';

/** Result of a completed action. Never set on a `requested` row. */
export type AuditOutcome = 'succeeded' | 'partial' | 'failed';

/**
 * The `requested` row, written by the API when a campaign is accepted.
 *
 * Carries the fields only the HTTP request knows — `requestIp`, `actorAzp`,
 * `endpoint`, the Keycloak subject. The worker cannot recover these later.
 */
export interface RequestedAuditInput {
  /** = `campaign_job.id`. */
  correlationId: string;
  channel: Exclude<AuditChannel, 'dump'>;
  actorUserId: string;
  actorOrgId: string;
  actorAzp?: string;
  /** PII field NAMES that this action will release. Never values. */
  piiFields: string[];
  itemCount: number;
  requestedAt: Date;
  network?: string;
  instance?: string;
  requestIp?: string;
  /** From the request envelope's `metadata` `purpose` key, when present. */
  purpose?: string;
  endpoint: string;
  /** Inbound `x-request-id`. */
  traceId?: string;
}

/**
 * The `completed` row, written by the worker once the job reaches a TERMINAL
 * status. Never written for a mid-sequence attempt that will be retried.
 *
 * `actorOrgId` is repeated here on purpose: the worker already loads the job,
 * so it is free, and it keeps "everything org X did" a single indexed scan
 * instead of a self-join.
 */
export interface CompletedAuditInput {
  correlationId: string;
  channel: Exclude<AuditChannel, 'dump'>;
  actorOrgId: string;
  outcome: AuditOutcome;
  completedAt: Date;
  /** `raya` | the mail provider | `s3://bucket/key`. */
  destination?: string;
  resolvedCount?: number;
  skippedCount?: number;
  failedCount?: number;
  sentCount?: number;
  errorCode?: string;
  /** Export-link recipient — an OPERATOR address. */
  recipientRef?: string;
}

/**
 * The single row for a non-PII dump access.
 *
 * The dump is synchronous, has no org, no items and no purpose, so it produces
 * ONE row rather than the request/complete pair. `actorOrgId` is absent by
 * design — that is the signature of a whole-network access.
 */
export interface DumpAuditInput {
  /** Generated per request — there is no job to borrow an id from. */
  correlationId: string;
  actorUserId: string;
  actorAzp?: string;
  outcome: AuditOutcome;
  completedAt: Date;
  /** The bucket/prefix that was pre-signed. */
  destination?: string;
  network?: string;
  instance?: string;
  requestIp?: string;
  endpoint: string;
  traceId?: string;
  errorCode?: string;
  /** Non-PII extras, e.g. `{ files: 3, bytes: 1234 }`. */
  details?: Record<string, unknown>;
}

/**
 * Append-only audit writer. Implementations must never expose update, delete,
 * or read.
 */
export abstract class CampaignAuditWriterBase {
  /**
   * Appends the `requested` row for a campaign action, at the moment the API
   * accepts it and before any work has started.
   *
   * @param input - Request-time fields the worker cannot recover later
   *   (requester identity, endpoint, PII field names, item count).
   * @returns ok(void) on successful insert; err(BaseError) on validation
   *   failure or DB/upstream error.
   */
  abstract recordRequested(input: RequestedAuditInput): Promise<Result<void, BaseError>>;

  /**
   * Appends the `completed` row once a campaign job reaches a TERMINAL
   * status. Must not be called for a mid-sequence attempt that will retry.
   *
   * @param input - Outcome + counts for the finished job, keyed by the same
   *   `correlationId` as the matching `recordRequested` call.
   * @returns ok(void) on successful insert; err(BaseError) on validation
   *   failure or DB/upstream error.
   */
  abstract recordCompleted(input: CompletedAuditInput): Promise<Result<void, BaseError>>;

  /**
   * Appends the single row for a synchronous, non-PII dump access.
   *
   * @param input - Requester identity + outcome for the whole-network dump;
   *   has no `actorOrgId` by design.
   * @returns ok(void) on successful insert; err(BaseError) on validation
   *   failure or DB/upstream error.
   */
  abstract recordDumpAccess(input: DumpAuditInput): Promise<Result<void, BaseError>>;
}
