/**
 * Postgres adapter for the registration links store.
 *
 * Wraps Drizzle queries against `registration_links`. Driver-specific errors
 * are mapped to abstract `StoreError` codes — callers reason in domain terms.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { aggregators, registrationLinks, type RegistrationLinkRow } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import {
  RegistrationLinksStoreBase,
  type CreateRegistrationLinkInput,
  type ListRegistrationLinksOptions,
  type ListRegistrationLinksResult,
  type RegistrationLink,
  type RegistrationLinkStatus,
  type StoreResult,
  type UpdateDraftInput,
} from './interface.js';

const PG_UNIQUE_VIOLATION = '23505';

export class PostgresRegistrationLinksStore extends RegistrationLinksStoreBase {
  async create(input: CreateRegistrationLinkInput): Promise<StoreResult<RegistrationLink>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .insert(registrationLinks)
        .values({
          aggregatorId: input.aggregatorId,
          slug: input.slug,
          domain: input.domain,
          context: input.context,
          status: input.status ?? 'draft',
          registrationMode: input.registrationMode ?? 'form',
          expiresAt: input.expiresAt ?? null,
          createdBy: input.createdBy,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'no row returned' } };
      }
      logger.info({
        operation: 'registrationLinksStore.create',
        status: 'success',
        latency_ms: Date.now() - start,
        link_id: row.id,
        aggregator_id: row.aggregatorId,
      });
      return { ok: true, value: toDomain(row) };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) {
        return {
          ok: false,
          error: { code: 'SLUG_COLLISION', message: 'slug already in use' },
        };
      }
      logger.error({
        operation: 'registrationLinksStore.create',
        status: 'failure',
        error: (err as Error).message,
        error_type: (err as Error).constructor.name,
        latency_ms: Date.now() - start,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async findBySlug(slug: string): Promise<StoreResult<RegistrationLink | null>> {
    try {
      const rows = await getDb()
        .select()
        .from(registrationLinks)
        .where(eq(registrationLinks.slug, slug))
        .limit(1);
      const row = rows[0];
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      logger.error({
        operation: 'registrationLinksStore.findBySlug',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async findByOrgAndSlug(
    orgSlug: string,
    slug: string,
  ): Promise<StoreResult<RegistrationLink | null>> {
    try {
      const rows = await getDb()
        .select({ link: registrationLinks })
        .from(registrationLinks)
        .innerJoin(aggregators, eq(registrationLinks.aggregatorId, aggregators.id))
        .where(and(eq(aggregators.orgSlug, orgSlug), eq(registrationLinks.slug, slug)))
        .limit(1);
      const row = rows[0]?.link;
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      logger.error({
        operation: 'registrationLinksStore.findByOrgAndSlug',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async findById(id: string, aggregatorId: string): Promise<StoreResult<RegistrationLink | null>> {
    try {
      const rows = await getDb()
        .select()
        .from(registrationLinks)
        .where(and(eq(registrationLinks.id, id), eq(registrationLinks.aggregatorId, aggregatorId)))
        .limit(1);
      const row = rows[0];
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      logger.error({
        operation: 'registrationLinksStore.findById',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async updateQrKey(
    id: string,
    aggregatorId: string,
    qrObjectKey: string,
  ): Promise<StoreResult<RegistrationLink>> {
    try {
      const rows = await getDb()
        .update(registrationLinks)
        .set({ qrObjectKey, updatedAt: new Date() })
        .where(and(eq(registrationLinks.id, id), eq(registrationLinks.aggregatorId, aggregatorId)))
        .returning();
      const row = rows[0];
      if (!row) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `link not found: ${id}` } };
      }
      return { ok: true, value: toDomain(row) };
    } catch (err: unknown) {
      logger.error({
        operation: 'registrationLinksStore.updateQrKey',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async list(
    aggregatorId: string,
    options: ListRegistrationLinksOptions,
  ): Promise<StoreResult<ListRegistrationLinksResult>> {
    try {
      const where = options.status
        ? and(
            eq(registrationLinks.aggregatorId, aggregatorId),
            eq(registrationLinks.status, options.status),
          )
        : eq(registrationLinks.aggregatorId, aggregatorId);
      const [rows, totalRows] = await Promise.all([
        getDb()
          .select()
          .from(registrationLinks)
          .where(where)
          .orderBy(desc(registrationLinks.createdAt))
          .limit(options.limit)
          .offset(options.offset),
        getDb()
          .select({ count: sql<number>`count(*)::int` })
          .from(registrationLinks)
          .where(where),
      ]);
      const total = totalRows[0]?.count ?? 0;
      return {
        ok: true,
        value: { rows: rows.map(toDomain), total },
      };
    } catch (err: unknown) {
      logger.error({
        operation: 'registrationLinksStore.list',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async updateDraft(
    id: string,
    aggregatorId: string,
    patch: UpdateDraftInput,
  ): Promise<StoreResult<RegistrationLink>> {
    const start = Date.now();
    try {
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.slug !== undefined) set.slug = patch.slug;
      if (patch.context !== undefined) set.context = patch.context;
      if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
      const rows = await getDb()
        .update(registrationLinks)
        .set(set)
        .where(
          and(
            eq(registrationLinks.id, id),
            eq(registrationLinks.aggregatorId, aggregatorId),
            // Only drafts are mutable — live rows have already published the
            // QR + public URL; mutating them in-place would invalidate the
            // posters in the field. Live → retire → recreate is the right flow.
            eq(registrationLinks.status, 'draft'),
          ),
        )
        .returning();
      const row = rows[0];
      if (!row) {
        return {
          ok: false,
          error: { code: 'NOT_FOUND', message: `draft link not found: ${id}` },
        };
      }
      logger.info({
        operation: 'registrationLinksStore.updateDraft',
        status: 'success',
        latency_ms: Date.now() - start,
        link_id: row.id,
        aggregator_id: row.aggregatorId,
        slug_changed: patch.slug !== undefined,
      });
      return { ok: true, value: toDomain(row) };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) {
        return {
          ok: false,
          error: { code: 'SLUG_COLLISION', message: 'slug already in use' },
        };
      }
      logger.error({
        operation: 'registrationLinksStore.updateDraft',
        status: 'failure',
        error: (err as Error).message,
        latency_ms: Date.now() - start,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async updateStatus(
    id: string,
    aggregatorId: string,
    nextStatus: RegistrationLinkStatus,
  ): Promise<StoreResult<RegistrationLink>> {
    try {
      const rows = await getDb()
        .update(registrationLinks)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(and(eq(registrationLinks.id, id), eq(registrationLinks.aggregatorId, aggregatorId)))
        .returning();
      const row = rows[0];
      if (!row) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `link not found: ${id}` } };
      }
      return { ok: true, value: toDomain(row) };
    } catch (err: unknown) {
      logger.error({
        operation: 'registrationLinksStore.updateStatus',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }
}

function toDomain(row: RegistrationLinkRow): RegistrationLink {
  return {
    id: row.id,
    aggregatorId: row.aggregatorId,
    slug: row.slug,
    domain: row.domain,
    context: row.context,
    registrationMode: typeof row.registrationMode === 'string' ? row.registrationMode : 'form',
    qrObjectKey: row.qrObjectKey,
    status: row.status,
    expiresAt: row.expiresAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
