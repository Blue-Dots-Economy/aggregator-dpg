/**
 * Shared repository contract test suite.
 *
 * Parameterised Vitest helper that exercises the Repository<TEntity, string, TFilter>
 * contract. Invoked once per implementation (in-memory fake, or real Postgres when
 * DATABASE_URL is set) to guarantee both backends stay aligned.
 *
 * @module @aggregator-dpg/db/__tests__
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Filter } from '@aggregator-dpg/shared-primitives/dto';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { CreateInput, UpdateInput, Repository } from '../../interface.js';

/** A factory that yields a fresh empty repo per test. */
export type RepoFactory<TEntity, TFilter extends Filter> = () => Repository<
  TEntity,
  string,
  TFilter
>;

/** Helpers the contract needs from each entity-specific test file. */
export interface ContractHelpers<TEntity, TFilter extends Filter> {
  /** Minimal valid CreateInput that satisfies the entity's constraints. */
  sampleCreateInput: () => CreateInput<TEntity>;
  /** Patch applied in update() tests; must produce observable change. */
  samplePatch: () => UpdateInput<TEntity>;
  /** Field on the patch that tests should assert changed. */
  patchedField: keyof TEntity;
  /** Extracts the PK from an entity. */
  getId: (e: TEntity) => string;
  /** Empty filter — passes every entity. */
  emptyFilter: TFilter;
  /** Filter that matches the entity created via sampleCreateInput(). */
  matchingFilter: (e: TEntity) => TFilter;
  /** Filter that should NOT match the entity created via sampleCreateInput(). */
  nonMatchingFilter: TFilter;
}

function unwrap<T>(r: Result<T, BaseError>): T {
  if (!r.success) throw new Error(`expected ok, got err: ${r.error.message}`);
  return r.value;
}

function unwrapErr<T>(r: Result<T, BaseError>): BaseError {
  if (r.success) throw new Error('expected err, got ok');
  return r.error;
}

/**
 * Runs the shared Repository contract suite.
 *
 * @param name - Display name for the describe() block.
 * @param factory - Returns a fresh empty repo instance.
 * @param helpers - Per-entity helpers for building test inputs and filters.
 */
export function runRepoContract<TEntity, TFilter extends Filter>(
  name: string,
  factory: RepoFactory<TEntity, TFilter>,
  helpers: ContractHelpers<TEntity, TFilter>,
): void {
  describe(`${name} — Repository contract`, () => {
    let repo: Repository<TEntity, string, TFilter>;

    beforeEach(() => {
      repo = factory();
    });

    it('getById returns null for unknown id', async () => {
      const r = unwrap(await repo.getById('non-existent-id'));
      expect(r).toBeNull();
    });

    it('create returns the created entity with a populated id', async () => {
      const created = unwrap(await repo.create(helpers.sampleCreateInput()));
      expect(helpers.getId(created)).toBeTruthy();
    });

    it('create + getById returns the same entity', async () => {
      const created = unwrap(await repo.create(helpers.sampleCreateInput()));
      const fetched = unwrap(await repo.getById(helpers.getId(created)));
      expect(fetched).not.toBeNull();
      expect(helpers.getId(fetched!)).toBe(helpers.getId(created));
    });

    it('findOne returns the entity matching a filter', async () => {
      const created = unwrap(await repo.create(helpers.sampleCreateInput()));
      const found = unwrap(await repo.findOne(helpers.matchingFilter(created)));
      expect(found).not.toBeNull();
      expect(helpers.getId(found!)).toBe(helpers.getId(created));
    });

    it('findOne returns null when no entity matches', async () => {
      await repo.create(helpers.sampleCreateInput());
      const r = unwrap(await repo.findOne(helpers.nonMatchingFilter));
      expect(r).toBeNull();
    });

    it('findMany returns all entities matching an empty filter', async () => {
      await repo.create(helpers.sampleCreateInput());
      await repo.create(helpers.sampleCreateInput());
      await repo.create(helpers.sampleCreateInput());
      const page = unwrap(await repo.findMany(helpers.emptyFilter));
      expect(page.items.length).toBeGreaterThanOrEqual(3);
      expect(page.total).toBeGreaterThanOrEqual(3);
    });

    it('findMany respects the limit paging option', async () => {
      await repo.create(helpers.sampleCreateInput());
      await repo.create(helpers.sampleCreateInput());
      await repo.create(helpers.sampleCreateInput());
      const page = unwrap(await repo.findMany(helpers.emptyFilter, { limit: 2 }));
      expect(page.items.length).toBeLessThanOrEqual(2);
    });

    it('findMany returns empty for non-matching filter', async () => {
      await repo.create(helpers.sampleCreateInput());
      const page = unwrap(await repo.findMany(helpers.nonMatchingFilter));
      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
    });

    it('update applies patch and returns the new entity', async () => {
      const created = unwrap(await repo.create(helpers.sampleCreateInput()));
      const patch = helpers.samplePatch();
      const updated = unwrap(await repo.update(helpers.getId(created), patch));
      const patchValue = (patch as Record<string, unknown>)[helpers.patchedField as string];
      expect(updated[helpers.patchedField]).toEqual(patchValue);
    });

    it('update on unknown id returns an error', async () => {
      const result = await repo.update('non-existent-id', helpers.samplePatch());
      const e = unwrapErr(result);
      expect(e).toBeDefined();
      expect(e.message).toBeTruthy();
    });

    it('delete removes the entity; subsequent getById returns null', async () => {
      const created = unwrap(await repo.create(helpers.sampleCreateInput()));
      unwrap(await repo.delete(helpers.getId(created)));
      const r = unwrap(await repo.getById(helpers.getId(created)));
      expect(r).toBeNull();
    });
  });
}

/**
 * Overrides for repos with mutation-prohibited contracts (e.g. audit_log).
 * Invoke instead of runRepoContract() for append-only entities.
 */
export function runAppendOnlyRepoContract<TEntity, TFilter extends Filter>(
  name: string,
  factory: RepoFactory<TEntity, TFilter>,
  helpers: ContractHelpers<TEntity, TFilter>,
  expectedCode: string,
): void {
  describe(`${name} — append-only contract`, () => {
    let repo: Repository<TEntity, string, TFilter>;

    beforeEach(() => {
      repo = factory();
    });

    it('create + getById works (append allowed)', async () => {
      const created = unwrap(await repo.create(helpers.sampleCreateInput()));
      const fetched = unwrap(await repo.getById(helpers.getId(created)));
      expect(fetched).not.toBeNull();
    });

    it('update returns DomainError with the immutability code', async () => {
      const created = unwrap(await repo.create(helpers.sampleCreateInput()));
      const r = await repo.update(helpers.getId(created), helpers.samplePatch());
      const e = unwrapErr(r) as BaseError & { code?: string };
      expect(e.code).toBe(expectedCode);
    });

    it('delete returns DomainError with the immutability code', async () => {
      const created = unwrap(await repo.create(helpers.sampleCreateInput()));
      const r = await repo.delete(helpers.getId(created));
      const e = unwrapErr(r) as BaseError & { code?: string };
      expect(e.code).toBe(expectedCode);
    });
  });
}
