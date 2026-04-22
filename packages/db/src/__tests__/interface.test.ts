import { describe, expect, expectTypeOf, it } from 'vitest';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Filter, Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import { ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import {
  DBService,
  Repository,
  type CreateInput,
  type UnitOfWork,
  type UpdateInput,
} from '../interface.js';

interface UserEntity {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
  updatedAt: Date;
}

type UserFilter = Filter<'email' | 'displayName' | 'createdAt'>;

class UserRepository extends Repository<UserEntity, string, UserFilter, Paging> {
  async getById(_id: string): Promise<Result<UserEntity | null, BaseError>> {
    return ok(null);
  }

  async findOne(_filter: UserFilter): Promise<Result<UserEntity | null, BaseError>> {
    return ok(null);
  }

  async findMany(
    _filter: UserFilter,
    _paging?: Paging,
  ): Promise<Result<Paginated<UserEntity>, BaseError>> {
    return ok({ items: [], total: 0 });
  }

  async create(input: CreateInput<UserEntity>): Promise<Result<UserEntity, BaseError>> {
    const now = new Date();
    return ok({ id: 'user-1', createdAt: now, updatedAt: now, ...input });
  }

  async update(id: string, patch: UpdateInput<UserEntity>): Promise<Result<UserEntity, BaseError>> {
    const now = new Date();
    return ok({
      id,
      email: patch.email ?? 'user@example.com',
      displayName: patch.displayName ?? 'User',
      createdAt: now,
      updatedAt: now,
    });
  }

  async delete(_id: string): Promise<Result<void, BaseError>> {
    return ok(undefined);
  }
}

class TestDBService extends DBService {
  async healthcheck(): Promise<Result<void, BaseError>> {
    return ok(undefined);
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  async transaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return fn({ transactionId: 'tx-1' });
  }
}

describe('db interface types', () => {
  it('models repository method contracts with shared filter and paging DTOs', () => {
    expectTypeOf<UserRepository>().toExtend<Repository<UserEntity, string, UserFilter, Paging>>();

    const repo = new UserRepository();
    expectTypeOf(repo.findMany).parameter(0).toEqualTypeOf<UserFilter>();
    expectTypeOf(repo.findMany).parameter(1).toEqualTypeOf<Paging | undefined>();
    expectTypeOf(repo.findMany).returns.resolves.toEqualTypeOf<
      Result<Paginated<UserEntity>, BaseError>
    >();
  });

  it('models create and update inputs without generated fields', () => {
    expectTypeOf<CreateInput<UserEntity>>().toEqualTypeOf<{
      email: string;
      displayName: string;
    }>();
    expectTypeOf<UpdateInput<UserEntity>>().toEqualTypeOf<{
      email?: string;
      displayName?: string;
    }>();

    const createInput: CreateInput<UserEntity> = {
      email: 'user@example.com',
      displayName: 'User',
    };
    const updateInput: UpdateInput<UserEntity> = { displayName: 'Renamed' };

    expect(createInput.email).toBe('user@example.com');
    expect(updateInput.displayName).toBe('Renamed');
  });

  it('models transaction callbacks with UnitOfWork only', async () => {
    const db = new TestDBService();
    const result = await db.transaction(async (uow) => {
      expectTypeOf(uow).toEqualTypeOf<UnitOfWork>();
      return uow.transactionId;
    });

    expect(result).toBe('tx-1');
  });
});
