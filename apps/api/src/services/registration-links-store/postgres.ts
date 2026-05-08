/**
 * Postgres adapter for the registration links store.
 *
 * Wraps Drizzle queries against `registration_links`. Driver-specific errors
 * are mapped to abstract `StoreError` codes — callers reason in domain terms.
 */

import { and, eq } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { registrationLinks, type RegistrationLinkRow } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import {
  RegistrationLinksStoreBase,
  type CreateRegistrationLinkInput,
  type RegistrationLink,
  type StoreResult,
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
}

function toDomain(row: RegistrationLinkRow): RegistrationLink {
  return {
    id: row.id,
    aggregatorId: row.aggregatorId,
    slug: row.slug,
    domain: row.domain,
    context: row.context,
    qrObjectKey: row.qrObjectKey,
    status: row.status,
    expiresAt: row.expiresAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
