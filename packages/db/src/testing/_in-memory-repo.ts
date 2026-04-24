/**
 * Shared base class for Map-backed in-memory repositories.
 *
 * Provides common CRUD, filter, and pagination logic so each entity fake
 * only declares the handful of per-entity hooks (id extraction, filter
 * match, cursor date, entity assembly).
 *
 * @module @aggregator-dpg/db/testing (internal)
 */

import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import type { Filter, Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { CreateInput, UpdateInput } from '../interface.js';
import { Repository } from '../interface.js';
import { decodeCursor } from '../repositories/_cursor.js';
import { buildPaginated } from '../repositories/_paginate.js';

/**
 * Base class for in-memory repositories backed by a `Map<string, TEntity>`.
 *
 * Subclasses implement four hooks:
 *   - getId(entity)              → primary-key string
 *   - getCursorDate(entity)      → sort/cursor timestamp (usually createdAt)
 *   - matchesFilter(entity, f)   → per-entity filter predicate
 *   - makeEntity(input)          → assembles a full entity from CreateInput
 *
 * Override applyPatch() if the entity needs special update-time behaviour
 * (e.g. refreshing updatedAt).
 */
export abstract class InMemoryRepo<TEntity, TFilter extends Filter = Filter> extends Repository<
  TEntity,
  string,
  TFilter
> {
  protected readonly store: Map<string, TEntity> = new Map();

  /** Per-entity: returns the primary-key string for an entity. */
  protected abstract getId(entity: TEntity): string;

  /** Per-entity: returns the date used for cursor-based pagination and sorting. */
  protected abstract getCursorDate(entity: TEntity): Date;

  /** Per-entity: returns true if the entity matches the supplied filter. */
  protected abstract matchesFilter(entity: TEntity, filter: TFilter): boolean;

  /** Per-entity: assembles a full entity from CreateInput with defaults (id, timestamps). */
  protected abstract makeEntity(input: CreateInput<TEntity>): TEntity;

  /** Override for custom paging defaults. */
  protected defaultLimit(): number {
    return 20;
  }

  /** Override to raise the ceiling for entities returning lots of rows per page. */
  protected maxLimit(): number {
    return 100;
  }

  /**
   * Override when updates need side-effects (e.g. refreshing updatedAt).
   * Default: shallow merge.
   */
  protected applyPatch(existing: TEntity, patch: UpdateInput<TEntity>): TEntity {
    return { ...existing, ...patch } as TEntity;
  }

  async getById(id: string): Promise<Result<TEntity | null, BaseError>> {
    return ok(this.store.get(id) ?? null);
  }

  async findOne(filter: TFilter): Promise<Result<TEntity | null, BaseError>> {
    for (const entity of this.store.values()) {
      if (this.matchesFilter(entity, filter)) return ok(entity);
    }
    return ok(null);
  }

  async findMany(filter: TFilter, paging?: Paging): Promise<Result<Paginated<TEntity>, BaseError>> {
    const limit = Math.min(paging?.limit ?? this.defaultLimit(), this.maxLimit());

    const matched = [...this.store.values()]
      .filter((e) => this.matchesFilter(e, filter))
      .sort((a, b) => this.getCursorDate(b).getTime() - this.getCursorDate(a).getTime());

    let page = matched;
    if (paging?.cursor) {
      const { createdAt } = decodeCursor(paging.cursor);
      page = matched.filter((e) => this.getCursorDate(e) < createdAt);
    }
    const items = page.slice(0, limit);

    return ok(
      buildPaginated(
        items,
        matched.length,
        limit,
        (e) => this.getId(e),
        (e) => this.getCursorDate(e),
      ),
    );
  }

  async create(input: CreateInput<TEntity>): Promise<Result<TEntity, BaseError>> {
    const entity = this.makeEntity(input);
    this.store.set(this.getId(entity), entity);
    return ok(entity);
  }

  async update(id: string, patch: UpdateInput<TEntity>): Promise<Result<TEntity, BaseError>> {
    const existing = this.store.get(id);
    if (!existing) {
      return err(
        new UpstreamError('update: row not found', {
          code: 'DB_NOT_FOUND',
          details: { id },
        }),
      );
    }
    const updated = this.applyPatch(existing, patch);
    this.store.set(id, updated);
    return ok(updated);
  }

  async delete(id: string): Promise<Result<void, BaseError>> {
    this.store.delete(id);
    return ok(undefined);
  }

  /**
   * Pre-populates the repo with entities. Test-only — bypasses create().
   *
   * @param entities - Fully-formed entities (ids and timestamps already set).
   */
  seed(entities: TEntity[]): void {
    for (const entity of entities) {
      this.store.set(this.getId(entity), entity);
    }
  }

  /** Clears all rows. Test-only. */
  clear(): void {
    this.store.clear();
  }

  /** Returns the total row count. Test-only. */
  size(): number {
    return this.store.size;
  }
}
