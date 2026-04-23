/**
 * Drizzle-backed repository for the onboarding_link table.
 *
 * @module @aggregator-dpg/db/repositories (internal)
 */

import { and, count, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Filter, Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { CreateInput, UpdateInput } from '../interface.js';
import { Repository } from '../interface.js';
import { onboardingLink } from '../schema/onboarding.js';
import type { DrizzleDB } from '../postgres/drizzle.js';
import { decodeCursor } from './_cursor.js';
import { buildPaginated, resolveLimit } from './_paginate.js';

export type OnboardingLinkEntity = typeof onboardingLink.$inferSelect;

/** Filter fields supported by OnboardingLinkRepo.findMany. */
export interface OnboardingLinkFilter extends Filter {
  aggregatorId?: string;
  mode?: 'link' | 'qr' | 'bulk';
  targetRole?: 'seeker' | 'provider';
}

/**
 * Repository for aggregator onboarding links and QR/bulk entry points.
 */
export class OnboardingLinkRepo extends Repository<
  OnboardingLinkEntity,
  string,
  OnboardingLinkFilter
> {
  constructor(private readonly db: DrizzleDB) {
    super();
  }

  async getById(id: string): Promise<Result<OnboardingLinkEntity | null, BaseError>> {
    try {
      const rows = await this.db
        .select()
        .from(onboardingLink)
        .where(eq(onboardingLink.id, id))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('onboarding_link.getById failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findOne(
    filter: OnboardingLinkFilter,
  ): Promise<Result<OnboardingLinkEntity | null, BaseError>> {
    try {
      const conditions = buildConditions(filter);
      const rows = await this.db
        .select()
        .from(onboardingLink)
        .where(and(...conditions))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('onboarding_link.findOne failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findMany(
    filter: OnboardingLinkFilter,
    paging?: Paging,
  ): Promise<Result<Paginated<OnboardingLinkEntity>, BaseError>> {
    try {
      const limit = resolveLimit(paging);
      const conditions = buildConditions(filter);

      if (paging?.cursor) {
        const { createdAt } = decodeCursor(paging.cursor);
        conditions.push(lt(onboardingLink.createdAt, createdAt));
      }

      const [countRow] = await this.db
        .select({ total: count() })
        .from(onboardingLink)
        .where(and(...buildConditions(filter)));
      const total = Number(countRow?.total ?? 0);

      const items = await this.db
        .select()
        .from(onboardingLink)
        .where(and(...conditions))
        .orderBy(desc(onboardingLink.createdAt))
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
        new UpstreamError('onboarding_link.findMany failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async create(
    input: CreateInput<OnboardingLinkEntity>,
  ): Promise<Result<OnboardingLinkEntity, BaseError>> {
    try {
      const [row] = await this.db
        .insert(onboardingLink)
        .values(input as typeof onboardingLink.$inferInsert)
        .returning();
      return ok(row!);
    } catch (e) {
      return err(
        new UpstreamError('onboarding_link.create failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async update(
    id: string,
    patch: UpdateInput<OnboardingLinkEntity>,
  ): Promise<Result<OnboardingLinkEntity, BaseError>> {
    try {
      const [row] = await this.db
        .update(onboardingLink)
        .set(patch as Partial<typeof onboardingLink.$inferInsert>)
        .where(eq(onboardingLink.id, id))
        .returning();
      if (!row) {
        return err(
          new UpstreamError('onboarding_link.update: row not found', {
            code: 'DB_NOT_FOUND',
            details: { id },
          }),
        );
      }
      return ok(row);
    } catch (e) {
      return err(
        new UpstreamError('onboarding_link.update failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async delete(id: string): Promise<Result<void, BaseError>> {
    try {
      await this.db.delete(onboardingLink).where(eq(onboardingLink.id, id));
      return ok(undefined);
    } catch (e) {
      return err(
        new UpstreamError('onboarding_link.delete failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  /**
   * Returns non-revoked, non-expired links for an aggregator.
   *
   * A link is active when revokedAt IS NULL and (expiresAt IS NULL OR expiresAt > now()).
   *
   * @param aggregatorId - UUID of the aggregator organisation.
   */
  async findActiveByAggregator(
    aggregatorId: string,
  ): Promise<Result<OnboardingLinkEntity[], BaseError>> {
    try {
      const rows = await this.db
        .select()
        .from(onboardingLink)
        .where(
          and(
            eq(onboardingLink.aggregatorId, aggregatorId),
            isNull(onboardingLink.revokedAt),
            or(isNull(onboardingLink.expiresAt), gt(onboardingLink.expiresAt, sql`now()`)),
          ),
        )
        .orderBy(desc(onboardingLink.createdAt));
      return ok(rows);
    } catch (e) {
      return err(
        new UpstreamError('onboarding_link.findActiveByAggregator failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  /**
   * Atomically increments join_count by 1 for a given link.
   *
   * Returns the updated row so the caller can confirm the new count.
   *
   * @param id - UUID of the onboarding link.
   */
  async incrementJoinCount(id: string): Promise<Result<OnboardingLinkEntity, BaseError>> {
    try {
      const [row] = await this.db
        .update(onboardingLink)
        .set({ joinCount: sql`${onboardingLink.joinCount} + 1` })
        .where(eq(onboardingLink.id, id))
        .returning();
      if (!row) {
        return err(
          new UpstreamError('onboarding_link.incrementJoinCount: row not found', {
            code: 'DB_NOT_FOUND',
            details: { id },
          }),
        );
      }
      return ok(row);
    } catch (e) {
      return err(
        new UpstreamError('onboarding_link.incrementJoinCount failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }
}

function buildConditions(filter: OnboardingLinkFilter) {
  const conditions = [];
  if (filter.aggregatorId !== undefined) {
    conditions.push(eq(onboardingLink.aggregatorId, filter.aggregatorId));
  }
  if (filter.mode !== undefined) {
    conditions.push(eq(onboardingLink.mode, filter.mode));
  }
  if (filter.targetRole !== undefined) {
    conditions.push(eq(onboardingLink.targetRole, filter.targetRole));
  }
  return conditions;
}
