/**
 * Postgres adapter for the registration store.
 *
 * State transitions use compare-and-set (WHERE id=? AND state=? AND version=?)
 * + version increment inside a single transaction that also writes the audit
 * row to `registration_transitions`. Any 0-row UPDATE returns STALE_TRANSITION
 * so the caller knows to treat it as a no-op.
 */

import { and, eq, inArray, not, or, sql } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { registrations, registrationTransitions } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import {
  RegistrationStoreBase,
  type CreateRegistrationInput,
  type ProvisionKey,
  type ProvisionStatus,
  type Registration,
  type RegistrationState,
  type StoreResult,
  type TransitionMeta,
  type TransitionPatch,
} from './interface.js';

const PG_UNIQUE_VIOLATION = '23505';
// 'active' is intentionally excluded: active registrations block re-registration with
// the same email/phone, and the reconciler must still retry failed projections on them.
const TERMINAL_STATES: RegistrationState[] = ['rejected', 'abandoned'];

export class PostgresRegistrationStore extends RegistrationStoreBase {
  async create(input: CreateRegistrationInput): Promise<StoreResult<Registration>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .insert(registrations)
        .values({
          idempotencyKey: input.idempotencyKey,
          contactEmail: input.contactEmail.toLowerCase(),
          contactPhone: input.contactPhone,
          orgName: input.orgName,
          orgType: input.orgType,
          orgUrl: input.orgUrl ?? null,
          orgLocations: input.orgLocations ?? [],
          profileDraft: input.profileDraft ?? {},
          consent: input.consent,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'no row returned' } };
      }
      logger.info({
        operation: 'registrationStore.create',
        status: 'success',
        latency_ms: Date.now() - start,
        registration_id: row.id,
      });
      return { ok: true, value: toDomain(row) };
    } catch (err: unknown) {
      return mapWriteError('registrationStore.create', err, start);
    }
  }

  async findByIdempotencyKey(key: string): Promise<StoreResult<Registration | null>> {
    try {
      const [row] = await getDb()
        .select()
        .from(registrations)
        .where(eq(registrations.idempotencyKey, key))
        .limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      return mapReadError('registrationStore.findByIdempotencyKey', err);
    }
  }

  async findByContact(
    field: 'email' | 'phone',
    value: string,
  ): Promise<StoreResult<Registration | null>> {
    try {
      const col = field === 'email' ? registrations.contactEmail : registrations.contactPhone;
      const normalised = field === 'email' ? value.toLowerCase() : value;
      const [row] = await getDb()
        .select()
        .from(registrations)
        .where(and(eq(col, normalised), not(inArray(registrations.state, TERMINAL_STATES))))
        .limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      return mapReadError('registrationStore.findByContact', err);
    }
  }

  async findById(id: string): Promise<StoreResult<Registration | null>> {
    try {
      const [row] = await getDb()
        .select()
        .from(registrations)
        .where(eq(registrations.id, id))
        .limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      return mapReadError('registrationStore.findById', err);
    }
  }

  async transition(
    id: string,
    fromState: RegistrationState,
    toState: RegistrationState,
    patch: TransitionPatch,
    version: number,
    meta: TransitionMeta,
  ): Promise<StoreResult<Registration>> {
    const start = Date.now();
    try {
      const result = await getDb().transaction(async (tx) => {
        const now = new Date();
        const updates: Record<string, unknown> = {
          state: toState,
          version: version + 1,
          updatedAt: now,
        };
        if (patch.idpUserId !== undefined) updates['idpUserId'] = patch.idpUserId;
        if (patch.signalstackOrgId !== undefined)
          updates['signalstackOrgId'] = patch.signalstackOrgId;
        if (patch.aggregatorId !== undefined) updates['aggregatorId'] = patch.aggregatorId;
        if (patch.verificationSentAt !== undefined)
          updates['verificationSentAt'] = patch.verificationSentAt;
        if (patch.verifiedAt !== undefined) updates['verifiedAt'] = patch.verifiedAt;
        if (patch.adminNotifiedAt !== undefined) updates['adminNotifiedAt'] = patch.adminNotifiedAt;
        if (patch.approvalLinkIssuedAt !== undefined)
          updates['approvalLinkIssuedAt'] = patch.approvalLinkIssuedAt;
        if ('reconcilerClaimedAt' in patch)
          updates['reconcilerClaimedAt'] = patch.reconcilerClaimedAt ?? null;

        const rows = await tx
          .update(registrations)
          .set(updates)
          .where(
            and(
              eq(registrations.id, id),
              eq(registrations.state, fromState),
              eq(registrations.version, version),
            ),
          )
          .returning();

        if (rows.length === 0) return null;

        await tx.insert(registrationTransitions).values({
          registrationId: id,
          fromState,
          toState,
          actor: meta.actor,
          reason: meta.reason ?? null,
        });

        return rows[0]!;
      });

      if (!result) {
        logger.warn({
          operation: 'registrationStore.transition',
          status: 'skipped',
          registration_id: id,
          from_state: fromState,
          to_state: toState,
          version,
          latency_ms: Date.now() - start,
        });
        return {
          ok: false,
          error: {
            code: 'STALE_TRANSITION',
            message: `no row matched id=${id} state=${fromState} version=${version}`,
          },
        };
      }

      logger.info({
        operation: 'registrationStore.transition',
        status: 'success',
        registration_id: id,
        from_state: fromState,
        to_state: toState,
        actor: meta.actor,
        latency_ms: Date.now() - start,
      });
      return { ok: true, value: toDomain(result) };
    } catch (err: unknown) {
      return mapWriteError('registrationStore.transition', err, start);
    }
  }

  async listNonTerminal(): Promise<StoreResult<Registration[]>> {
    try {
      const rows = await getDb()
        .select()
        .from(registrations)
        .where(not(inArray(registrations.state, TERMINAL_STATES)))
        .orderBy(registrations.createdAt);
      return { ok: true, value: rows.map(toDomain) };
    } catch (err: unknown) {
      return mapReadError('registrationStore.listNonTerminal', err);
    }
  }

  async listFlaggedForReconcile(): Promise<StoreResult<Registration[]>> {
    try {
      // Non-terminal rows where provision_state contains at least one 'failed' entry.
      const rows = await getDb()
        .select()
        .from(registrations)
        .where(
          and(
            not(inArray(registrations.state, TERMINAL_STATES)),
            or(
              sql`${registrations.provisionState} @> '{"verification":"failed"}'::jsonb`,
              sql`${registrations.provisionState} @> '{"admin_notify":"failed"}'::jsonb`,
              sql`${registrations.provisionState} @> '{"kc_user":"failed"}'::jsonb`,
              sql`${registrations.provisionState} @> '{"ss_org":"failed"}'::jsonb`,
              sql`${registrations.provisionState} @> '{"graduated":"failed"}'::jsonb`,
              sql`${registrations.provisionState} @> '{"welcome":"failed"}'::jsonb`,
              sql`${registrations.provisionState} @> '{"rejection":"failed"}'::jsonb`,
            ),
          ),
        )
        .orderBy(registrations.createdAt);
      return { ok: true, value: rows.map(toDomain) };
    } catch (err: unknown) {
      return mapReadError('registrationStore.listFlaggedForReconcile', err);
    }
  }

  async markProjection(
    id: string,
    key: ProvisionKey,
    status: ProvisionStatus,
  ): Promise<StoreResult<void>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .update(registrations)
        .set({
          provisionState: sql`${registrations.provisionState} || ${JSON.stringify({ [key]: status })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(registrations.id, id))
        .returning({ id: registrations.id });
      if (rows.length === 0) {
        return { ok: false, error: { code: 'NOT_FOUND', message: id } };
      }
      logger.info({
        operation: 'registrationStore.markProjection',
        status: 'success',
        registration_id: id,
        key,
        provision_status: status,
        latency_ms: Date.now() - start,
      });
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return mapWriteError('registrationStore.markProjection', err, start);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapWriteError(op: string, err: unknown, start: number): StoreResult<never> {
  const code = (err as { code?: string }).code;
  const constraint = (err as { constraint?: string }).constraint ?? '';
  const message = (err as Error).message ?? 'unknown';

  if (code === PG_UNIQUE_VIOLATION) {
    const storeCode = constraint.includes('idempotency_key')
      ? 'DUPLICATE_IDEMPOTENCY_KEY'
      : constraint.includes('contact_email')
        ? 'DUPLICATE_EMAIL'
        : constraint.includes('contact_phone')
          ? 'DUPLICATE_PHONE'
          : 'DUPLICATE_IDEMPOTENCY_KEY';
    logger.warn({
      operation: op,
      status: 'failure',
      error: storeCode,
      constraint,
      latency_ms: Date.now() - start,
    });
    return { ok: false, error: { code: storeCode, message: `${storeCode}: ${constraint}` } };
  }
  logger.error({
    operation: op,
    status: 'failure',
    error: message,
    error_type: (err as Error).constructor?.name,
    latency_ms: Date.now() - start,
  });
  return { ok: false, error: { code: 'DB_UNAVAILABLE', message } };
}

function mapReadError(op: string, err: unknown): StoreResult<never> {
  const message = (err as Error).message ?? 'unknown';
  logger.error({ operation: op, status: 'failure', error: message });
  return { ok: false, error: { code: 'DB_UNAVAILABLE', message } };
}

function toDomain(row: typeof registrations.$inferSelect): Registration {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    state: row.state,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    orgName: row.orgName,
    orgType: row.orgType,
    orgUrl: row.orgUrl,
    orgLocations: (row.orgLocations as Record<string, unknown>[]) ?? [],
    profileDraft: (row.profileDraft as Record<string, unknown>) ?? {},
    consent: (row.consent as Record<string, unknown>) ?? {},
    idpUserId: row.idpUserId,
    signalstackOrgId: row.signalstackOrgId,
    aggregatorId: row.aggregatorId,
    verificationSentAt: row.verificationSentAt,
    verifiedAt: row.verifiedAt,
    adminNotifiedAt: row.adminNotifiedAt,
    approvalLinkIssuedAt: row.approvalLinkIssuedAt,
    provisionState: (row.provisionState as Partial<Record<ProvisionKey, ProvisionStatus>>) ?? {},
    version: row.version,
    reconcilerClaimedAt: row.reconcilerClaimedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
