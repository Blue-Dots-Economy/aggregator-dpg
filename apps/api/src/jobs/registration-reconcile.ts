/**
 * Level-triggered registration FSM reconciler.
 *
 * Each tick:
 *   1. Claims non-terminal rows whose reconcilerClaimedAt is null or stale.
 *   2. Abandons rows that have exceeded their TTL.
 *   3. Retries failed or missing provisioning steps (graduation, email,
 *      SignalStack push). KC-user steps are logged as warnings only — they
 *      require an admin to re-approve via the portal.
 *   4. Releases the claim on each row after processing.
 *
 * All per-row errors are caught and counted; the tick always returns a
 * `ReconcileOutcome` summarising what happened.
 *
 * Invoked on demand via admin API endpoints — no automatic scheduler.
 */

import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb, schema } from '../db/client.js';
import { config, adminEmails } from '../config.js';
import { logger } from '../logger.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { getMailer } from '../services/mailer/index.js';
import {
  mintRegistrationApprovalToken,
  mintVerificationToken,
} from '../services/approval-token.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReconcileOutcome {
  /** Rows examined this tick. */
  examined: number;
  /** Rows transitioned to `abandoned` this tick. */
  abandoned: number;
  /** Rows successfully graduated (approved → active) this tick. */
  graduated: number;
  /** Admin notification emails sent this tick. */
  adminNotified: number;
  /** Welcome emails sent this tick. */
  welcomed: number;
  /** Rejection emails sent this tick. */
  rejectionsSent: number;
  /** SignalStack org push attempts that succeeded this tick. */
  ssPushed: number;
  /** Rows with KC-user issues (not retried — needs admin action). */
  kcWarnings: number;
  /** Verification emails sent (submitted rows) this tick. */
  verificationEmailsSent: number;
  /** Rows that encountered errors during this tick's processing. */
  errors: number;
}

type RegistrationRow = typeof schema.registrations.$inferSelect;

// States the reconciler cares about (all non-terminal).
const RECONCILABLE_STATES = ['submitted', 'verified', 'approved', 'active'] as const;

// Claim TTL — how long a claimed row is locked. If a reconcile tick takes
// longer than this, another tick can reclaim the row. Fixed at 10 min.
const CLAIM_TTL_MS = 10 * 60 * 1000;

// ─── Public entrypoint ───────────────────────────────────────────────────────

/**
 * Runs one reconciler tick.
 *
 * Atomically claims all unclaimed (or stale-claimed) non-terminal rows,
 * repairs each one, then emits a single structured log line with aggregate
 * counters.
 *
 * @returns Typed outcome with per-category counts.
 */
export async function runRegistrationReconcile(): Promise<ReconcileOutcome> {
  const start = Date.now();
  const log = logger.child({ operation: 'reconciler.registration' });

  const outcome: ReconcileOutcome = {
    examined: 0,
    abandoned: 0,
    graduated: 0,
    adminNotified: 0,
    welcomed: 0,
    rejectionsSent: 0,
    ssPushed: 0,
    kcWarnings: 0,
    verificationEmailsSent: 0,
    errors: 0,
  };

  // ── Step 1: claim all unclaimed / stale-claimed non-terminal rows ───────────
  const claimExpiry = new Date(Date.now() - CLAIM_TTL_MS);
  const claimedAt = new Date();

  let rows: RegistrationRow[];
  try {
    rows = await getDb()
      .update(schema.registrations)
      .set({ reconcilerClaimedAt: claimedAt, updatedAt: new Date() })
      .where(
        and(
          inArray(schema.registrations.state, [...RECONCILABLE_STATES]),
          or(
            isNull(schema.registrations.reconcilerClaimedAt),
            lt(schema.registrations.reconcilerClaimedAt, claimExpiry),
          ),
        ),
      )
      .returning();
  } catch (err: unknown) {
    log.error({
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
    return outcome;
  }

  outcome.examined = rows.length;
  if (rows.length === 0) {
    log.info({ status: 'success', ...outcome, latency_ms: Date.now() - start });
    return outcome;
  }

  // ── Step 2: process each claimed row ────────────────────────────────────────
  await Promise.all(
    rows.map(async (row) => {
      try {
        await processRow(row, outcome);
      } catch (err: unknown) {
        outcome.errors += 1;
        log.error({
          status: 'row_error',
          registration_id: row.id,
          registration_state: row.state,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Release claim regardless of outcome.
        await releaseClaim(row.id);
      }
    }),
  );

  log.info({ status: 'success', ...outcome, latency_ms: Date.now() - start });
  return outcome;
}

/**
 * Runs the reconciler for a single registration row identified by contact.
 *
 * Used by the admin by-contact endpoint to repair a specific registration
 * without running a full tick.
 *
 * @param field - `'email'` or `'phone'`
 * @param value - Contact value to look up.
 * @returns Outcome (examined will be 0 if not found, 1 if found).
 */
export async function reconcileByContact(
  field: 'email' | 'phone',
  value: string,
): Promise<ReconcileOutcome & { registration?: RegistrationRow }> {
  const outcome: ReconcileOutcome = {
    examined: 0,
    abandoned: 0,
    graduated: 0,
    adminNotified: 0,
    welcomed: 0,
    rejectionsSent: 0,
    ssPushed: 0,
    kcWarnings: 0,
    verificationEmailsSent: 0,
    errors: 0,
  };

  const column =
    field === 'email' ? schema.registrations.contactEmail : schema.registrations.contactPhone;
  const normalised = field === 'email' ? value.toLowerCase().trim() : value.trim();

  let row: RegistrationRow | undefined;
  try {
    row = await getDb().query.registrations.findFirst({
      where: and(
        eq(sql`lower(${column})`, normalised),
        inArray(schema.registrations.state, [...RECONCILABLE_STATES]),
      ),
    });
  } catch (err: unknown) {
    outcome.errors += 1;
    logger.error({
      operation: 'reconciler.byContact',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
    });
    return outcome;
  }

  if (!row) return outcome;

  outcome.examined = 1;
  try {
    await processRow(row, outcome);
  } catch (err: unknown) {
    outcome.errors += 1;
    logger.error({
      operation: 'reconciler.byContact.row_error',
      registration_id: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await releaseClaim(row.id);
  }

  // Re-read row so the response reflects updated state/provision_state.
  const fresh = await getDb().query.registrations.findFirst({
    where: eq(schema.registrations.id, row.id),
  });

  return { ...outcome, registration: fresh ?? row };
}

// ─── Pure TTL helpers (exported for unit tests) ─────────────────────────────

/**
 * Returns true when a `submitted` registration has exceeded the unverified TTL.
 *
 * @param createdAt - Row creation timestamp.
 * @param ttlHours - Maximum hours before abandonment.
 * @param now - Override for current time (default Date.now()).
 */
export function isUnverifiedExpired(createdAt: Date, ttlHours: number, now = Date.now()): boolean {
  return createdAt.getTime() < now - ttlHours * 3600_000;
}

/**
 * Returns true when a `verified` or `approved` registration has not progressed
 * within the stuck TTL window.
 *
 * @param updatedAt - Last-updated timestamp.
 * @param ttlHours - Maximum hours before abandonment.
 * @param now - Override for current time (default Date.now()).
 */
export function isStuckExpired(updatedAt: Date, ttlHours: number, now = Date.now()): boolean {
  return updatedAt.getTime() < now - ttlHours * 3600_000;
}

// ─── Per-row processor ───────────────────────────────────────────────────────

async function processRow(row: RegistrationRow, outcome: ReconcileOutcome): Promise<void> {
  const state = row.state;
  const ps = (row.provisionState ?? {}) as Record<string, string>;

  // ── TTL abandonment ─────────────────────────────────────────────────────────
  const unverifiedCutoff = new Date(
    Date.now() - config.REGISTRATION_UNVERIFIED_TTL_HOURS * 3600_000,
  );
  const stuckCutoff = new Date(Date.now() - config.REGISTRATION_STUCK_TTL_HOURS * 3600_000);

  if (state === 'submitted' && row.createdAt < unverifiedCutoff) {
    await abandon(row, 'unverified_ttl_exceeded');
    outcome.abandoned += 1;
    return;
  }

  if ((state === 'verified' || state === 'approved') && row.updatedAt < stuckCutoff) {
    await abandon(row, 'stuck_ttl_exceeded');
    outcome.abandoned += 1;
    return;
  }

  // ── Per-state provisioning ──────────────────────────────────────────────────
  switch (state) {
    case 'verified':
      if (ps['admin_notify'] !== 'done') {
        const sent = await retryAdminNotify(row);
        if (sent) outcome.adminNotified += 1;
      }
      break;

    case 'approved': {
      if (ps['graduated'] !== 'done') {
        const graduated = await retryGraduation(row);
        if (graduated) {
          outcome.graduated += 1;
          const fresh = await getDb().query.registrations.findFirst({
            where: eq(schema.registrations.id, row.id),
          });
          if (fresh) {
            await postGraduationProvision(fresh, outcome);
          }
        }
      } else {
        const fresh = await getDb().query.registrations.findFirst({
          where: eq(schema.registrations.id, row.id),
        });
        if (fresh && fresh.state === 'active') {
          await postGraduationProvision(fresh, outcome);
        }
      }
      break;
    }

    case 'active':
      await postGraduationProvision(row, outcome);
      break;

    case 'rejected':
      if (ps['rejection'] !== 'done') {
        const sent = await retryRejectionEmail(row);
        if (sent) outcome.rejectionsSent += 1;
      }
      if (ps['kc_user'] !== 'done') {
        outcome.kcWarnings += 1;
        logger.warn({
          operation: 'reconciler.registration.kc_warning',
          registration_id: row.id,
          reason: 'kc_user_not_disabled_needs_admin',
        });
      }
      break;

    case 'submitted':
      if (ps['verification'] !== 'done') {
        const sent = await retryVerificationEmail(row);
        if (sent) outcome.verificationEmailsSent += 1;
      }
      break;
  }
}

async function postGraduationProvision(
  row: RegistrationRow,
  outcome: ReconcileOutcome,
): Promise<void> {
  const ps = (row.provisionState ?? {}) as Record<string, string>;

  if (ps['kc_user'] !== 'done') {
    outcome.kcWarnings += 1;
    logger.warn({
      operation: 'reconciler.registration.kc_warning',
      registration_id: row.id,
      reason: 'kc_user_not_created_needs_admin',
    });
  }

  if (ps['ss_org'] !== 'done') {
    const pushed = await retrySsPush(row);
    if (pushed) outcome.ssPushed += 1;
  }

  if (ps['welcome'] !== 'done') {
    const sent = await retryWelcomeEmail(row);
    if (sent) outcome.welcomed += 1;
  }
}

// ─── Abandonment ─────────────────────────────────────────────────────────────

async function abandon(row: RegistrationRow, reason: string): Promise<void> {
  const op = 'reconciler.registration.abandon';
  const start = Date.now();
  try {
    await getDb()
      .update(schema.registrations)
      .set({
        state: 'abandoned',
        version: row.version + 1,
        updatedAt: new Date(),
        reconcilerClaimedAt: null,
      })
      .where(
        and(eq(schema.registrations.id, row.id), eq(schema.registrations.version, row.version)),
      );

    await getDb().insert(schema.registrationTransitions).values({
      registrationId: row.id,
      fromState: row.state,
      toState: 'abandoned',
      actor: 'reconciler',
      reason,
    });

    logger.info({
      operation: op,
      status: 'success',
      registration_id: row.id,
      from_state: row.state,
      reason,
      latency_ms: Date.now() - start,
    });
  } catch (err: unknown) {
    logger.error({
      operation: op,
      status: 'failure',
      registration_id: row.id,
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
  }
}

// ─── Graduation ──────────────────────────────────────────────────────────────

async function retryGraduation(row: RegistrationRow): Promise<boolean> {
  const op = 'reconciler.registration.graduate';
  const start = Date.now();

  try {
    const orgSlug = slugFromName(row.orgName);
    const now = new Date();

    let aggregatorId: string | null = null;
    try {
      const [agg] = await getDb()
        .insert(schema.aggregators)
        .values({
          orgSlug,
          actorType: 'aggregator',
          name: row.orgName,
          type: row.orgType ?? null,
          url: row.orgUrl ?? null,
          contact: {
            name: extractContactName(row),
            phone: row.contactPhone,
            email: row.contactEmail,
          } as never,
          locations: (row.orgLocations ?? []) as never,
          consent: (row.consent ?? {}) as never,
          createdBy: 'system',
          updatedBy: 'system',
        })
        .onConflictDoNothing()
        .returning({ id: schema.aggregators.id });
      aggregatorId = agg?.id ?? null;
    } catch {
      // Slug conflict — retry with a unique suffix.
      const retrySuffix = randomBytes(2).toString('hex');
      const [agg] = await getDb()
        .insert(schema.aggregators)
        .values({
          orgSlug: `${slugFromName(row.orgName)}-${retrySuffix}`,
          actorType: 'aggregator',
          name: row.orgName,
          type: row.orgType ?? null,
          url: row.orgUrl ?? null,
          contact: {
            name: extractContactName(row),
            phone: row.contactPhone,
            email: row.contactEmail,
          } as never,
          locations: (row.orgLocations ?? []) as never,
          consent: (row.consent ?? {}) as never,
          createdBy: 'system',
          updatedBy: 'system',
        })
        .onConflictDoNothing()
        .returning({ id: schema.aggregators.id });
      aggregatorId = agg?.id ?? null;
      if (!aggregatorId) {
        const existing = await getDb().query.aggregators.findFirst({
          where: (t) => eq(sql`lower((${t.contact}->>'email'))`, row.contactEmail.toLowerCase()),
          columns: { id: true },
        });
        aggregatorId = existing?.id ?? null;
      }
    }

    if (!aggregatorId) {
      const existing = await getDb().query.aggregators.findFirst({
        where: (t) => eq(sql`lower((${t.contact}->>'email'))`, row.contactEmail.toLowerCase()),
        columns: { id: true },
      });
      aggregatorId = existing?.id ?? null;
    }

    if (!aggregatorId) {
      await markProjection(row.id, 'graduated', 'failed');
      logger.error({
        operation: op,
        status: 'failure',
        registration_id: row.id,
        error: 'could not find or create aggregator row',
        latency_ms: Date.now() - start,
      });
      return false;
    }

    await getDb()
      .insert(schema.aggregatorProfile)
      .values({
        aggregatorId,
        contactName: extractContactName(row),
        createdBy: 'system',
        updatedBy: 'system',
      })
      .onConflictDoNothing();

    const updated = await getDb()
      .update(schema.registrations)
      .set({
        state: 'active',
        aggregatorId,
        version: sql`${schema.registrations.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.registrations.id, row.id),
          eq(schema.registrations.version, row.version),
          eq(schema.registrations.state, 'approved'),
        ),
      )
      .returning({ id: schema.registrations.id });

    if (updated.length === 0) {
      logger.info({
        operation: op,
        status: 'skipped',
        registration_id: row.id,
        reason: 'stale_transition_likely_concurrent',
        latency_ms: Date.now() - start,
      });
      return false;
    }

    await getDb().insert(schema.registrationTransitions).values({
      registrationId: row.id,
      fromState: 'approved',
      toState: 'active',
      actor: 'reconciler',
      reason: 'graduation',
    });

    await markProjection(row.id, 'graduated', 'done');

    logger.info({
      operation: op,
      status: 'success',
      registration_id: row.id,
      aggregator_id: aggregatorId,
      latency_ms: Date.now() - start,
    });
    return true;
  } catch (err: unknown) {
    await markProjection(row.id, 'graduated', 'failed');
    logger.error({
      operation: op,
      status: 'failure',
      registration_id: row.id,
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
    return false;
  }
}

// ─── SignalStack push ─────────────────────────────────────────────────────────

async function retrySsPush(row: RegistrationRow): Promise<boolean> {
  const op = 'reconciler.registration.ss_push';
  const start = Date.now();
  const writer = getSignalStackWriter();

  if (!writer) {
    logger.debug({ operation: op, status: 'skipped', reason: 'no_signalstack_writer' });
    return false;
  }

  if (!row.aggregatorId) {
    logger.debug({
      operation: op,
      status: 'skipped',
      registration_id: row.id,
      reason: 'awaiting_graduation',
    });
    return false;
  }

  try {
    const agg = await getDb().query.aggregators.findFirst({
      where: eq(schema.aggregators.id, row.aggregatorId),
      columns: { id: true, name: true, orgSlug: true },
    });

    if (!agg) {
      await markProjection(row.id, 'ss_org', 'failed');
      logger.error({
        operation: op,
        status: 'failure',
        registration_id: row.id,
        error: 'aggregator row not found',
        latency_ms: Date.now() - start,
      });
      return false;
    }

    const result = await writer.upsertAggregator({
      external_id: row.aggregatorId,
      name: agg.name,
      slug: agg.orgSlug,
    });

    if (!result.success) {
      await markProjection(row.id, 'ss_org', 'failed');
      logger.error({
        operation: op,
        status: 'failure',
        registration_id: row.id,
        error: result.error.message,
        latency_ms: Date.now() - start,
      });
      return false;
    }

    const ssOrgId = result.value.org_id;

    await Promise.all([
      getDb()
        .update(schema.registrations)
        .set({ signalstackOrgId: ssOrgId, updatedAt: new Date() })
        .where(eq(schema.registrations.id, row.id)),
      getDb()
        .update(schema.aggregators)
        .set({ signalstackOrgId: ssOrgId, updatedAt: new Date() })
        .where(eq(schema.aggregators.id, row.aggregatorId)),
    ]);

    await markProjection(row.id, 'ss_org', 'done');
    logger.info({
      operation: op,
      status: 'success',
      registration_id: row.id,
      ss_org_id: ssOrgId,
      latency_ms: Date.now() - start,
    });
    return true;
  } catch (err: unknown) {
    await markProjection(row.id, 'ss_org', 'failed');
    logger.error({
      operation: op,
      status: 'failure',
      registration_id: row.id,
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
    return false;
  }
}

// ─── Email re-sends ───────────────────────────────────────────────────────────

async function retryVerificationEmail(row: RegistrationRow): Promise<boolean> {
  const op = 'reconciler.registration.verification';
  const start = Date.now();
  const mailer = getMailer();

  const portalUrl = config.PUBLIC_PORTAL_URL ?? config.PUBLIC_API_URL;
  if (!portalUrl) {
    logger.warn({
      operation: op,
      status: 'skipped',
      registration_id: row.id,
      reason: 'PUBLIC_PORTAL_URL not configured',
    });
    return false;
  }

  const cooldownMs = config.REGISTRATION_RESEND_COOLDOWN_MINUTES * 60_000;
  if (row.verificationSentAt && Date.now() - row.verificationSentAt.getTime() < cooldownMs) {
    logger.debug({ operation: op, status: 'skipped', registration_id: row.id, reason: 'cooldown' });
    return false;
  }

  try {
    const { token } = await mintVerificationToken({
      registrationId: row.id,
      ttlSec: config.REGISTRATION_VERIFICATION_TTL_MINUTES * 60,
    });
    const verifyUrl = `${portalUrl}/register/verify?id=${encodeURIComponent(row.id)}&token=${encodeURIComponent(token)}`;

    const subject = 'Verify your email — Blue Dots aggregator registration';
    const text = `Please verify your email address to continue your Blue Dots aggregator registration.\n\nVerify: ${verifyUrl}\n\nThis link expires in ${config.REGISTRATION_VERIFICATION_TTL_MINUTES} minutes. If you did not register, ignore this email.`;
    const html = `<p>Please verify your email address to continue your Blue Dots aggregator registration.</p><p><a href="${verifyUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Verify email address</a></p><p style="color:#6b7280;font-size:13px;">This link expires in ${config.REGISTRATION_VERIFICATION_TTL_MINUTES} minutes.</p>`;

    const result = await mailer.send({ to: row.contactEmail, subject, text, html });
    if (!result.ok) {
      await markProjection(row.id, 'verification', 'failed');
      logger.error({
        operation: op,
        status: 'failure',
        registration_id: row.id,
        error: result.error,
        latency_ms: Date.now() - start,
      });
      return false;
    }

    await getDb()
      .update(schema.registrations)
      .set({ verificationSentAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.registrations.id, row.id));
    await markProjection(row.id, 'verification', 'done');
    logger.info({
      operation: op,
      status: 'success',
      registration_id: row.id,
      latency_ms: Date.now() - start,
    });
    return true;
  } catch (err: unknown) {
    await markProjection(row.id, 'verification', 'failed');
    logger.error({
      operation: op,
      status: 'failure',
      registration_id: row.id,
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
    return false;
  }
}

async function retryAdminNotify(row: RegistrationRow): Promise<boolean> {
  const op = 'reconciler.registration.admin_notify';
  const start = Date.now();

  const cooldownMs = config.REGISTRATION_RESEND_COOLDOWN_MINUTES * 60_000;
  if (row.adminNotifiedAt && Date.now() - row.adminNotifiedAt.getTime() < cooldownMs) {
    logger.debug({ operation: op, status: 'skipped', registration_id: row.id, reason: 'cooldown' });
    return false;
  }

  if (adminEmails.length === 0) {
    logger.warn({
      operation: op,
      status: 'skipped',
      registration_id: row.id,
      reason: 'no_admin_emails',
    });
    return false;
  }

  const apiUrl = config.PUBLIC_API_URL;
  if (!apiUrl) {
    logger.warn({
      operation: op,
      status: 'skipped',
      registration_id: row.id,
      reason: 'PUBLIC_API_URL not configured',
    });
    return false;
  }

  try {
    const ttlSec = 7 * 24 * 3600;
    const [approveResult, rejectResult] = await Promise.all([
      mintRegistrationApprovalToken({ registrationId: row.id, intent: 'approve', ttlSec }),
      mintRegistrationApprovalToken({ registrationId: row.id, intent: 'reject', ttlSec }),
    ]);

    const approveUrl = `${apiUrl}/admin/v1/aggregator-registrations/read/${encodeURIComponent(row.id)}?intent=approve&token=${encodeURIComponent(approveResult.token)}`;
    const rejectUrl = `${apiUrl}/admin/v1/aggregator-registrations/read/${encodeURIComponent(row.id)}?intent=reject&token=${encodeURIComponent(rejectResult.token)}`;
    const contactName = extractContactName(row);

    const subject = `[Blue Dots] New registration: ${row.orgName}`;
    const text = [
      `A new aggregator registration requires your review.`,
      ``,
      `Organisation: ${row.orgName}`,
      `Contact: ${contactName} <${row.contactEmail}>`,
      `Phone: ${row.contactPhone}`,
      `Type: ${row.orgType}`,
      ``,
      `Approve: ${approveUrl}`,
      `Reject:  ${rejectUrl}`,
    ].join('\n');
    const html = text.replace(/\n/g, '<br>');

    const mailer = getMailer();
    const result = await mailer.send({ to: adminEmails, subject, text, html });
    if (!result.ok) {
      await markProjection(row.id, 'admin_notify', 'failed');
      logger.error({
        operation: op,
        status: 'failure',
        registration_id: row.id,
        error: result.error,
        latency_ms: Date.now() - start,
      });
      return false;
    }

    await getDb()
      .update(schema.registrations)
      .set({ adminNotifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.registrations.id, row.id));
    await markProjection(row.id, 'admin_notify', 'done');
    logger.info({
      operation: op,
      status: 'success',
      registration_id: row.id,
      admin_count: adminEmails.length,
      latency_ms: Date.now() - start,
    });
    return true;
  } catch (err: unknown) {
    await markProjection(row.id, 'admin_notify', 'failed');
    logger.error({
      operation: op,
      status: 'failure',
      registration_id: row.id,
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
    return false;
  }
}

async function retryWelcomeEmail(row: RegistrationRow): Promise<boolean> {
  const op = 'reconciler.registration.welcome';
  const start = Date.now();
  const mailer = getMailer();
  const portalUrl = config.PUBLIC_PORTAL_URL ?? config.PUBLIC_API_URL ?? '';

  try {
    const contactName = extractContactName(row);
    const subject = 'Welcome to Blue Dots — your account is ready';
    const text = [
      `Dear ${contactName},`,
      ``,
      `Your Blue Dots aggregator account for ${row.orgName} has been approved.`,
      portalUrl ? `Log in at: ${portalUrl}` : '',
      ``,
      `If you have questions, reply to this email.`,
    ]
      .filter(Boolean)
      .join('\n');
    const html = text.replace(/\n/g, '<br>');

    const result = await mailer.send({ to: row.contactEmail, subject, text, html });
    if (!result.ok) {
      await markProjection(row.id, 'welcome', 'failed');
      logger.error({
        operation: op,
        status: 'failure',
        registration_id: row.id,
        error: result.error,
        latency_ms: Date.now() - start,
      });
      return false;
    }

    await markProjection(row.id, 'welcome', 'done');
    logger.info({
      operation: op,
      status: 'success',
      registration_id: row.id,
      latency_ms: Date.now() - start,
    });
    return true;
  } catch (err: unknown) {
    await markProjection(row.id, 'welcome', 'failed');
    logger.error({
      operation: op,
      status: 'failure',
      registration_id: row.id,
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
    return false;
  }
}

async function retryRejectionEmail(row: RegistrationRow): Promise<boolean> {
  const op = 'reconciler.registration.rejection';
  const start = Date.now();
  const mailer = getMailer();

  try {
    const contactName = extractContactName(row);
    const subject = 'Blue Dots registration — application not approved';
    const text = [
      `Dear ${contactName},`,
      ``,
      `We have reviewed your application for ${row.orgName} and are unable to approve it at this time.`,
      ``,
      `If you believe this is an error or would like to appeal, please contact us.`,
    ].join('\n');
    const html = text.replace(/\n/g, '<br>');

    const result = await mailer.send({ to: row.contactEmail, subject, text, html });
    if (!result.ok) {
      await markProjection(row.id, 'rejection', 'failed');
      logger.error({
        operation: op,
        status: 'failure',
        registration_id: row.id,
        error: result.error,
        latency_ms: Date.now() - start,
      });
      return false;
    }

    await markProjection(row.id, 'rejection', 'done');
    logger.info({
      operation: op,
      status: 'success',
      registration_id: row.id,
      latency_ms: Date.now() - start,
    });
    return true;
  } catch (err: unknown) {
    await markProjection(row.id, 'rejection', 'failed');
    logger.error({
      operation: op,
      status: 'failure',
      registration_id: row.id,
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
    return false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function releaseClaim(id: string): Promise<void> {
  try {
    await getDb()
      .update(schema.registrations)
      .set({ reconcilerClaimedAt: null, updatedAt: new Date() })
      .where(eq(schema.registrations.id, id));
  } catch {
    // Non-fatal: the claim TTL will expire naturally.
  }
}

async function markProjection(id: string, key: string, status: 'done' | 'failed'): Promise<void> {
  try {
    await getDb()
      .update(schema.registrations)
      .set({
        provisionState: sql`${schema.registrations.provisionState} || ${JSON.stringify({ [key]: status })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(schema.registrations.id, id));
  } catch {
    // Best-effort: log only, never throw.
  }
}

function slugify(input: string): string {
  const cleaned = (input ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'org';
}

function slugFromName(name: string): string {
  return `${slugify(name)}-${randomBytes(2).toString('hex')}`;
}

function extractContactName(row: RegistrationRow): string {
  const draft = row.profileDraft as Record<string, unknown>;
  const name = draft['contact_name'] ?? draft['name'] ?? draft['contactName'];
  return typeof name === 'string' && name.trim() ? name.trim() : row.orgName;
}
