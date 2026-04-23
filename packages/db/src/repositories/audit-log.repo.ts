/**
 * Drizzle-backed repository for the audit_log table.
 *
 * audit_log is append-only — update() and delete() throw DomainError to
 * enforce immutability. No UPDATE or DELETE should ever reach this table.
 *
 * @module @aggregator-dpg/db/repositories (internal)
 */

import { and, count, desc, eq, lt } from 'drizzle-orm';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { DomainError, UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Filter, Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { CreateInput, UpdateInput } from '../interface.js';
import { Repository } from '../interface.js';
import { auditLog } from '../schema/audit.js';
import type { DrizzleDB } from '../postgres/drizzle.js';
import { decodeCursor } from './_cursor.js';
import { buildPaginated, resolveLimit } from './_paginate.js';

export type AuditLogEntity = typeof auditLog.$inferSelect;

/** Filter fields supported by AuditLogRepo.findMany. */
export interface AuditLogFilter extends Filter {
  aggregatorId?: string;
  userId?: string;
  action?: string;
  entity?: string;
  entityId?: string;
}

/**
 * Repository for the immutable audit trail.
 *
 * Only create() and read methods are valid. update() and delete() always
 * return DomainError — callers must never attempt to mutate audit records.
 */
export class AuditLogRepo extends Repository<AuditLogEntity, string, AuditLogFilter> {
  constructor(private readonly db: DrizzleDB) {
    super();
  }

  async getById(id: string): Promise<Result<AuditLogEntity | null, BaseError>> {
    try {
      const rows = await this.db.select().from(auditLog).where(eq(auditLog.id, id)).limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('audit_log.getById failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findOne(filter: AuditLogFilter): Promise<Result<AuditLogEntity | null, BaseError>> {
    try {
      const conditions = buildConditions(filter);
      const rows = await this.db
        .select()
        .from(auditLog)
        .where(and(...conditions))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('audit_log.findOne failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findMany(
    filter: AuditLogFilter,
    paging?: Paging,
  ): Promise<Result<Paginated<AuditLogEntity>, BaseError>> {
    try {
      const limit = resolveLimit(paging, 50, 200);
      const conditions = buildConditions(filter);

      if (paging?.cursor) {
        const { createdAt } = decodeCursor(paging.cursor);
        conditions.push(lt(auditLog.occurredAt, createdAt));
      }

      const [countRow] = await this.db
        .select({ total: count() })
        .from(auditLog)
        .where(and(...buildConditions(filter)));
      const total = Number(countRow?.total ?? 0);

      const items = await this.db
        .select()
        .from(auditLog)
        .where(and(...conditions))
        .orderBy(desc(auditLog.occurredAt))
        .limit(limit);

      return ok(
        buildPaginated(
          items,
          total,
          limit,
          (i) => i.id,
          (i) => i.occurredAt,
        ),
      );
    } catch (e) {
      return err(
        new UpstreamError('audit_log.findMany failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async create(input: CreateInput<AuditLogEntity>): Promise<Result<AuditLogEntity, BaseError>> {
    try {
      const [row] = await this.db
        .insert(auditLog)
        .values(input as typeof auditLog.$inferInsert)
        .returning();
      return ok(row!);
    } catch (e) {
      return err(
        new UpstreamError('audit_log.create failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  /**
   * Always returns DomainError — audit log records are immutable.
   */
   
  async update(
    _id: string,
    _patch: UpdateInput<AuditLogEntity>,
  ): Promise<Result<AuditLogEntity, BaseError>> {
    return err(
      new DomainError('audit log records are immutable and cannot be updated', {
        code: 'AUDIT_LOG_IMMUTABLE',
      }),
    );
  }

  /**
   * Always returns DomainError — audit log records are immutable.
   */
   
  async delete(_id: string): Promise<Result<void, BaseError>> {
    return err(
      new DomainError('audit log records are immutable and cannot be deleted', {
        code: 'AUDIT_LOG_IMMUTABLE',
      }),
    );
  }

  /**
   * Returns audit trail for an aggregator, newest event first.
   *
   * @param aggregatorId - UUID of the aggregator organisation.
   * @param paging - Optional cursor-based paging.
   */
  async findByAggregator(
    aggregatorId: string,
    paging?: Paging,
  ): Promise<Result<Paginated<AuditLogEntity>, BaseError>> {
    return this.findMany({ aggregatorId }, paging);
  }

  /**
   * Returns all audit events for a specific entity instance.
   *
   * @param entity - Entity type (e.g. 'onboarding_link').
   * @param entityId - PK of the affected entity row.
   * @param paging - Optional cursor-based paging.
   */
  async findByEntity(
    entity: string,
    entityId: string,
    paging?: Paging,
  ): Promise<Result<Paginated<AuditLogEntity>, BaseError>> {
    return this.findMany({ entity, entityId }, paging);
  }
}

function buildConditions(filter: AuditLogFilter) {
  const conditions = [];
  if (filter.aggregatorId !== undefined) {
    conditions.push(eq(auditLog.aggregatorId, filter.aggregatorId));
  }
  if (filter.userId !== undefined) {
    conditions.push(eq(auditLog.userId, filter.userId));
  }
  if (filter.action !== undefined) {
    conditions.push(eq(auditLog.action, filter.action));
  }
  if (filter.entity !== undefined) {
    conditions.push(eq(auditLog.entity, filter.entity));
  }
  if (filter.entityId !== undefined) {
    conditions.push(eq(auditLog.entityId, filter.entityId));
  }
  return conditions;
}
