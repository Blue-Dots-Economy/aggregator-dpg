/**
 * In-memory fake for AuditLogRepo.
 *
 * audit_log is append-only: update() and delete() return DomainError to
 * match the Postgres impl's contract.
 *
 * @module @aggregator-dpg/db/testing
 */

import { randomUUID } from 'node:crypto';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { DomainError } from '@aggregator-dpg/shared-primitives/errors';
import { err } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { CreateInput, UpdateInput } from '../interface.js';
import type { AuditLogEntity, AuditLogFilter } from '../repositories/audit-log.repo.js';
import { InMemoryRepo } from './_in-memory-repo.js';

export class InMemoryAuditLogRepo extends InMemoryRepo<AuditLogEntity, AuditLogFilter> {
  protected override defaultLimit(): number {
    return 50;
  }

  protected override maxLimit(): number {
    return 200;
  }

  protected getId(e: AuditLogEntity): string {
    return e.id;
  }

  /** Audit log sorts by occurredAt (event time), not createdAt. */
  protected getCursorDate(e: AuditLogEntity): Date {
    return e.occurredAt;
  }

  protected matchesFilter(e: AuditLogEntity, f: AuditLogFilter): boolean {
    if (f.aggregatorId !== undefined && e.aggregatorId !== f.aggregatorId) return false;
    if (f.userId !== undefined && e.userId !== f.userId) return false;
    if (f.action !== undefined && e.action !== f.action) return false;
    if (f.entity !== undefined && e.entity !== f.entity) return false;
    if (f.entityId !== undefined && e.entityId !== f.entityId) return false;
    return true;
  }

  protected makeEntity(input: CreateInput<AuditLogEntity>): AuditLogEntity {
    const i = input as {
      aggregatorId: string;
      userId?: string | null;
      action: string;
      entity: string;
      entityId: string;
      payloadJson?: unknown;
      occurredAt: Date;
    };
    return {
      id: randomUUID(),
      aggregatorId: i.aggregatorId,
      userId: i.userId ?? null,
      action: i.action,
      entity: i.entity,
      entityId: i.entityId,
      payloadJson: i.payloadJson ?? null,
      occurredAt: i.occurredAt,
      createdAt: new Date(),
    };
  }

  /** Always returns DomainError — audit log records are immutable. */
  override async update(
    _id: string,
    _patch: UpdateInput<AuditLogEntity>,
  ): Promise<Result<AuditLogEntity, BaseError>> {
    return err(
      new DomainError('audit log records are immutable and cannot be updated', {
        code: 'AUDIT_LOG_IMMUTABLE',
      }),
    );
  }

  /** Always returns DomainError — audit log records are immutable. */
  override async delete(_id: string): Promise<Result<void, BaseError>> {
    return err(
      new DomainError('audit log records are immutable and cannot be deleted', {
        code: 'AUDIT_LOG_IMMUTABLE',
      }),
    );
  }

  async findByAggregator(
    aggregatorId: string,
    paging?: Paging,
  ): Promise<Result<Paginated<AuditLogEntity>, BaseError>> {
    return this.findMany({ aggregatorId }, paging);
  }

  async findByEntity(
    entity: string,
    entityId: string,
    paging?: Paging,
  ): Promise<Result<Paginated<AuditLogEntity>, BaseError>> {
    return this.findMany({ entity, entityId }, paging);
  }
}

export function buildAuditLog(overrides: Partial<AuditLogEntity> = {}): AuditLogEntity {
  return {
    id: 'audit-default',
    aggregatorId: 'agg-default',
    userId: null,
    action: 'create',
    entity: 'onboarding_link',
    entityId: 'entity-default',
    payloadJson: null,
    occurredAt: new Date('2024-01-01T00:00:00Z'),
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
