/**
 * Public persistence contract for the aggregator-dpg platform.
 *
 * Consumers import only from this subpath. Concrete implementations such as
 * Postgres and in-memory fakes must stay behind their own implementation
 * subpaths and must not leak SQL, driver clients, pools, or transaction handles
 * through this interface.
 *
 * @module @aggregator-dpg/db/interface
 */

import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Filter, Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

/**
 * Generic create payload for repositories.
 *
 * Entity-specific repositories may narrow this type later when database-backed
 * table models are introduced.
 */
export type CreateInput<TEntity> = Omit<TEntity, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Generic update payload for repositories.
 *
 * Updates are partial patches by default; entity-specific repositories may
 * narrow this to stricter patch DTOs.
 */
export type UpdateInput<TEntity> = Partial<CreateInput<TEntity>>;

/**
 * Minimal transaction scope passed to DBService.transaction callbacks.
 *
 * Entity-specific repository handles are added in later P-04 features; this
 * marker keeps the initial contract adapter-neutral.
 */
export interface UnitOfWork {
  readonly transactionId: string;
}

/**
 * Generic repository contract for persistence-backed entities.
 *
 * @typeParam TEntity - Entity returned by the repository.
 * @typeParam TId - Identifier type for the entity.
 * @typeParam TFilter - Query filter DTO accepted by this repository.
 * @typeParam TPaging - Paging DTO accepted by this repository.
 */
export abstract class Repository<
  TEntity,
  TId,
  TFilter extends Filter = Filter,
  TPaging extends Paging = Paging,
> {
  abstract getById(id: TId): Promise<Result<TEntity | null, BaseError>>;

  abstract findOne(filter: TFilter): Promise<Result<TEntity | null, BaseError>>;

  abstract findMany(
    filter: TFilter,
    paging?: TPaging,
  ): Promise<Result<Paginated<TEntity>, BaseError>>;

  abstract create(input: CreateInput<TEntity>): Promise<Result<TEntity, BaseError>>;

  abstract update(id: TId, patch: UpdateInput<TEntity>): Promise<Result<TEntity, BaseError>>;

  abstract delete(id: TId): Promise<Result<void, BaseError>>;
}

/**
 * Database service contract used by composition roots and services.
 */
export abstract class DBService {
  /**
   * Checks that the backing datastore is reachable and ready.
   */
  abstract healthcheck(): Promise<Result<void, BaseError>>;

  /**
   * Closes all underlying datastore resources.
   */
  abstract close(): Promise<void>;

  /**
   * Runs work in a transaction. Implementations commit on success and roll back
   * when the callback throws or rejects.
   */
  abstract transaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}
