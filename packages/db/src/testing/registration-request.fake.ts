/**
 * In-memory fake for RegistrationRequestRepo.
 *
 * @module @aggregator-dpg/db/testing
 */

import { randomUUID } from 'node:crypto';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { CreateInput } from '../interface.js';
import type {
  RegistrationRequestEntity,
  RegistrationRequestFilter,
} from '../repositories/registration-request.repo.js';
import { InMemoryRepo } from './_in-memory-repo.js';

export class InMemoryRegistrationRequestRepo extends InMemoryRepo<
  RegistrationRequestEntity,
  RegistrationRequestFilter
> {
  protected getId(e: RegistrationRequestEntity): string {
    return e.id;
  }

  protected getCursorDate(e: RegistrationRequestEntity): Date {
    return e.createdAt;
  }

  protected matchesFilter(e: RegistrationRequestEntity, f: RegistrationRequestFilter): boolean {
    if (f.status !== undefined && e.status !== f.status) return false;
    if (f.email !== undefined && e.email !== f.email) return false;
    return true;
  }

  protected makeEntity(input: CreateInput<RegistrationRequestEntity>): RegistrationRequestEntity {
    const i = input as {
      orgName: string;
      aggregatorType: string;
      adminName: string;
      email: string;
      phone: string;
      consentAt: Date;
      status?: 'pending' | 'approved' | 'rejected';
    };
    return {
      id: randomUUID(),
      orgName: i.orgName,
      aggregatorType: i.aggregatorType,
      adminName: i.adminName,
      email: i.email,
      phone: i.phone,
      consentAt: i.consentAt,
      status: i.status ?? 'pending',
      createdAt: new Date(),
    };
  }

  async findByStatus(
    status: 'pending' | 'approved' | 'rejected',
    paging?: Paging,
  ): Promise<Result<Paginated<RegistrationRequestEntity>, BaseError>> {
    return this.findMany({ status }, paging);
  }
}

export function buildRegistrationRequest(
  overrides: Partial<RegistrationRequestEntity> = {},
): RegistrationRequestEntity {
  return {
    id: 'reg-default',
    orgName: 'Default Org',
    aggregatorType: 'employer',
    adminName: 'Admin Default',
    email: 'admin@example.com',
    phone: '+910000000000',
    consentAt: new Date('2024-01-01T00:00:00Z'),
    status: 'pending',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
