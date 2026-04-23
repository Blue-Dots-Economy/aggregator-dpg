/**
 * Drizzle-backed repository for the registration_request table.
 *
 * @module @aggregator-dpg/db/repositories (internal)
 */

import { and, count, desc, eq, lt } from 'drizzle-orm';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Filter, Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { CreateInput, UpdateInput } from '../interface.js';
import { Repository } from '../interface.js';
import { registrationRequest } from '../schema/registration.js';
import type { DrizzleDB } from '../postgres/drizzle.js';
import { decodeCursor } from './_cursor.js';
import { buildPaginated, resolveLimit } from './_paginate.js';

export type RegistrationRequestEntity = typeof registrationRequest.$inferSelect;

/** Filter fields supported by RegistrationRequestRepo.findMany. */
export interface RegistrationRequestFilter extends Filter {
  status?: 'pending' | 'approved' | 'rejected';
  email?: string;
}

/**
 * Repository for inbound aggregator registration requests.
 *
 * No FK to aggregator_profile — a new profile is created by the admin
 * workflow after approval.
 */
export class RegistrationRequestRepo extends Repository<
  RegistrationRequestEntity,
  string,
  RegistrationRequestFilter
> {
  constructor(private readonly db: DrizzleDB) {
    super();
  }

  async getById(id: string): Promise<Result<RegistrationRequestEntity | null, BaseError>> {
    try {
      const rows = await this.db
        .select()
        .from(registrationRequest)
        .where(eq(registrationRequest.id, id))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('registration_request.getById failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findOne(
    filter: RegistrationRequestFilter,
  ): Promise<Result<RegistrationRequestEntity | null, BaseError>> {
    try {
      const conditions = buildConditions(filter);
      const rows = await this.db
        .select()
        .from(registrationRequest)
        .where(and(...conditions))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('registration_request.findOne failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findMany(
    filter: RegistrationRequestFilter,
    paging?: Paging,
  ): Promise<Result<Paginated<RegistrationRequestEntity>, BaseError>> {
    try {
      const limit = resolveLimit(paging);
      const conditions = buildConditions(filter);

      if (paging?.cursor) {
        const { createdAt } = decodeCursor(paging.cursor);
        conditions.push(lt(registrationRequest.createdAt, createdAt));
      }

      const [countRow] = await this.db
        .select({ total: count() })
        .from(registrationRequest)
        .where(and(...buildConditions(filter)));
      const total = Number(countRow?.total ?? 0);

      const items = await this.db
        .select()
        .from(registrationRequest)
        .where(and(...conditions))
        .orderBy(desc(registrationRequest.createdAt))
        .limit(limit);

      return ok(
        buildPaginated(
          items,
          total,
          limit,
          (i) => i.id,
          (i) => i.createdAt,
        ),
      );
    } catch (e) {
      return err(
        new UpstreamError('registration_request.findMany failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async create(
    input: CreateInput<RegistrationRequestEntity>,
  ): Promise<Result<RegistrationRequestEntity, BaseError>> {
    try {
      const [row] = await this.db
        .insert(registrationRequest)
        .values(input as typeof registrationRequest.$inferInsert)
        .returning();
      return ok(row!);
    } catch (e) {
      return err(
        new UpstreamError('registration_request.create failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async update(
    id: string,
    patch: UpdateInput<RegistrationRequestEntity>,
  ): Promise<Result<RegistrationRequestEntity, BaseError>> {
    try {
      const [row] = await this.db
        .update(registrationRequest)
        .set(patch as Partial<typeof registrationRequest.$inferInsert>)
        .where(eq(registrationRequest.id, id))
        .returning();
      if (!row) {
        return err(
          new UpstreamError('registration_request.update: row not found', {
            code: 'DB_NOT_FOUND',
            details: { id },
          }),
        );
      }
      return ok(row);
    } catch (e) {
      return err(
        new UpstreamError('registration_request.update failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async delete(id: string): Promise<Result<void, BaseError>> {
    try {
      await this.db.delete(registrationRequest).where(eq(registrationRequest.id, id));
      return ok(undefined);
    } catch (e) {
      return err(
        new UpstreamError('registration_request.delete failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  /**
   * Returns registration requests filtered by lifecycle status.
   *
   * Primary use: populating the admin review queue (status = 'pending').
   *
   * @param status - Target lifecycle status.
   * @param paging - Optional cursor-based paging.
   */
  async findByStatus(
    status: 'pending' | 'approved' | 'rejected',
    paging?: Paging,
  ): Promise<Result<Paginated<RegistrationRequestEntity>, BaseError>> {
    return this.findMany({ status }, paging);
  }
}

function buildConditions(filter: RegistrationRequestFilter) {
  const conditions = [];
  if (filter.status !== undefined) {
    conditions.push(eq(registrationRequest.status, filter.status));
  }
  if (filter.email !== undefined) {
    conditions.push(eq(registrationRequest.email, filter.email));
  }
  return conditions;
}
