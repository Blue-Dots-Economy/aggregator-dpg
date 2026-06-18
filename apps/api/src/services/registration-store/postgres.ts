/**
 * Postgres adapter for the registration store.
 *
 * State transitions use compare-and-set (WHERE id=? AND state=? AND version=?)
 * + version increment inside a single transaction that also writes the audit
 * row to `registration_transitions`. Any 0-row UPDATE returns STALE_TRANSITION
 * so the caller knows to treat it as a no-op.
 */

import { and, desc, eq, inArray, isNull, lt, not, or, sql } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { registrations, registrationTransitions } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import {
  RegistrationStoreBase,
  type CreateRegistrationInput,
  type MarkProjectionOpts,
  type ProvisionAttemptEntry,
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
        // Timestamps accept null to allow re-open resets.
        if ('verificationSentAt' in patch)
          updates['verificationSentAt'] = patch.verificationSentAt ?? null;
        if ('verifiedAt' in patch) updates['verifiedAt'] = patch.verifiedAt ?? null;
        if ('adminNotifiedAt' in patch) updates['adminNotifiedAt'] = patch.adminNotifiedAt ?? null;
        if ('approvalLinkIssuedAt' in patch)
          updates['approvalLinkIssuedAt'] = patch.approvalLinkIssuedAt ?? null;
        if ('welcomeSentAt' in patch) updates['welcomeSentAt'] = patch.welcomeSentAt ?? null;
        if ('rejectionSentAt' in patch) updates['rejectionSentAt'] = patch.rejectionSentAt ?? null;
        if ('reconcilerClaimedAt' in patch)
          updates['reconcilerClaimedAt'] = patch.reconcilerClaimedAt ?? null;
        if ('provisionState' in patch) updates['provisionState'] = patch.provisionState ?? {};

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
      // Non-terminal rows where provision_state has at least one 'failed' entry.
      // Uses jsonb_each_text for a key-agnostic check that automatically covers
      // all current and future ProvisionKey values without hardcoded lists.
      const rows = await getDb()
        .select()
        .from(registrations)
        .where(
          and(
            not(inArray(registrations.state, TERMINAL_STATES)),
            sql`EXISTS (
              SELECT 1 FROM jsonb_each_text(${registrations.provisionState}) AS kv
              WHERE kv.value = 'failed'
            )`,
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
    opts?: MarkProjectionOpts,
  ): Promise<StoreResult<void>> {
    const start = Date.now();
    try {
      const setFields: Record<string, unknown> = {
        // No-downgrade guard: never overwrite a 'done' step with any other status.
        provisionState: sql`CASE WHEN ${registrations.provisionState}->>${key} = 'done'
          THEN ${registrations.provisionState}
          ELSE ${registrations.provisionState} || ${JSON.stringify({ [key]: status })}::jsonb
        END`,
        updatedAt: new Date(),
      };

      if (opts?.bumpAttempt) {
        // Increment attempts and stamp last_attempt_at in a single jsonb_set call.
        setFields['provisionAttempts'] = sql`jsonb_set(
          ${registrations.provisionAttempts},
          ARRAY[${key}::text],
          jsonb_build_object(
            'attempts', COALESCE((${registrations.provisionAttempts}->${key}->>'attempts')::int, 0) + 1,
            'last_attempt_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ),
          true
        )`;
      }

      const rows = await getDb()
        .update(registrations)
        .set(setFields)
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
        bump_attempt: opts?.bumpAttempt ?? false,
        latency_ms: Date.now() - start,
      });
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return mapWriteError('registrationStore.markProjection', err, start);
    }
  }

  async setIdpUserId(id: string, userId: string): Promise<StoreResult<void>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .update(registrations)
        .set({ idpUserId: userId, updatedAt: new Date() })
        .where(eq(registrations.id, id))
        .returning({ id: registrations.id });
      if (rows.length === 0) {
        return { ok: false, error: { code: 'NOT_FOUND', message: id } };
      }
      logger.info({
        operation: 'registrationStore.setIdpUserId',
        status: 'success',
        registration_id: id,
        latency_ms: Date.now() - start,
      });
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return mapWriteError('registrationStore.setIdpUserId', err, start);
    }
  }

  async claimRow(id: string, claimedAt: Date, expiry: Date): Promise<StoreResult<boolean>> {
    const start = Date.now();
    try {
      // Win the claim if: no existing claim OR the existing claim is stale (before expiry).
      const rows = await getDb()
        .update(registrations)
        .set({ reconcilerClaimedAt: claimedAt, updatedAt: new Date() })
        .where(
          and(
            eq(registrations.id, id),
            or(
              isNull(registrations.reconcilerClaimedAt),
              lt(registrations.reconcilerClaimedAt, expiry),
            ),
          ),
        )
        .returning({ id: registrations.id });
      const won = rows.length > 0;
      logger.info({
        operation: 'registrationStore.claimRow',
        status: won ? 'success' : 'skipped',
        registration_id: id,
        latency_ms: Date.now() - start,
      });
      return { ok: true, value: won };
    } catch (err: unknown) {
      return mapWriteError('registrationStore.claimRow', err, start);
    }
  }

  async releaseClaim(id: string, claimedAt: Date): Promise<StoreResult<void>> {
    const start = Date.now();
    try {
      // Compare-and-clear: only clear if we still own the claim.
      await getDb()
        .update(registrations)
        .set({ reconcilerClaimedAt: null, updatedAt: new Date() })
        .where(and(eq(registrations.id, id), eq(registrations.reconcilerClaimedAt, claimedAt)));
      logger.info({
        operation: 'registrationStore.releaseClaim',
        status: 'success',
        registration_id: id,
        latency_ms: Date.now() - start,
      });
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return mapWriteError('registrationStore.releaseClaim', err, start);
    }
  }

  async purgePii(id: string): Promise<StoreResult<void>> {
    const start = Date.now();
    try {
      // Redact all PII to sentinels in one UPDATE.  All three columns are NOT NULL
      // so we write non-null sentinels rather than NULL.  The 'purged' projection
      // is stamped atomically so re-runs guard correctly on provisionState.purged.
      const rows = await getDb()
        .update(registrations)
        .set({
          contactEmail: `purged-${id}@redacted.invalid`,
          contactPhone: '',
          profileDraft: {},
          provisionState: sql`${registrations.provisionState} || '{"purged":"done"}'::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(registrations.id, id))
        .returning({ id: registrations.id });
      if (rows.length === 0) {
        return { ok: false, error: { code: 'NOT_FOUND', message: id } };
      }
      logger.info({
        operation: 'registrationStore.purgePii',
        status: 'success',
        registration_id: id,
        latency_ms: Date.now() - start,
      });
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return mapWriteError('registrationStore.purgePii', err, start);
    }
  }

  async findAbandonedByContact(
    field: 'email' | 'phone',
    value: string,
  ): Promise<StoreResult<Registration | null>> {
    try {
      const col = field === 'email' ? registrations.contactEmail : registrations.contactPhone;
      const normalised = field === 'email' ? value.toLowerCase() : value;
      const [row] = await getDb()
        .select()
        .from(registrations)
        .where(and(eq(col, normalised), eq(registrations.state, 'abandoned')))
        .orderBy(desc(registrations.updatedAt))
        .limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      return mapReadError('registrationStore.findAbandonedByContact', err);
    }
  }

  async getPreAbandonmentState(id: string): Promise<StoreResult<RegistrationState | null>> {
    try {
      const [row] = await getDb()
        .select({ fromState: registrationTransitions.fromState })
        .from(registrationTransitions)
        .where(
          and(
            eq(registrationTransitions.registrationId, id),
            eq(registrationTransitions.toState, 'abandoned'),
          ),
        )
        .orderBy(desc(registrationTransitions.at))
        .limit(1);
      return { ok: true, value: (row?.fromState as RegistrationState) ?? null };
    } catch (err: unknown) {
      return mapReadError('registrationStore.getPreAbandonmentState', err);
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
    welcomeSentAt: row.welcomeSentAt,
    rejectionSentAt: row.rejectionSentAt,
    provisionState: (row.provisionState as Partial<Record<ProvisionKey, ProvisionStatus>>) ?? {},
    provisionAttempts:
      (row.provisionAttempts as Partial<Record<ProvisionKey, ProvisionAttemptEntry>>) ?? {},
    version: row.version,
    reconcilerClaimedAt: row.reconcilerClaimedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
