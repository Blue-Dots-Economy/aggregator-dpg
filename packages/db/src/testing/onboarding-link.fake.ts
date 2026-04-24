/**
 * In-memory fake for OnboardingLinkRepo.
 *
 * @module @aggregator-dpg/db/testing
 */

import { randomUUID } from 'node:crypto';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { CreateInput } from '../interface.js';
import type {
  OnboardingLinkEntity,
  OnboardingLinkFilter,
} from '../repositories/onboarding-link.repo.js';
import { InMemoryRepo } from './_in-memory-repo.js';

export class InMemoryOnboardingLinkRepo extends InMemoryRepo<
  OnboardingLinkEntity,
  OnboardingLinkFilter
> {
  protected getId(e: OnboardingLinkEntity): string {
    return e.id;
  }

  protected getCursorDate(e: OnboardingLinkEntity): Date {
    return e.createdAt;
  }

  protected matchesFilter(e: OnboardingLinkEntity, f: OnboardingLinkFilter): boolean {
    if (f.aggregatorId !== undefined && e.aggregatorId !== f.aggregatorId) return false;
    if (f.mode !== undefined && e.mode !== f.mode) return false;
    if (f.targetRole !== undefined && e.targetRole !== f.targetRole) return false;
    return true;
  }

  protected makeEntity(input: CreateInput<OnboardingLinkEntity>): OnboardingLinkEntity {
    const i = input as {
      aggregatorId: string;
      mode: 'link' | 'qr' | 'bulk';
      targetRole: 'seeker' | 'provider';
      label: string;
      joinCount?: number;
      expiresAt?: Date | null;
      revokedAt?: Date | null;
    };
    return {
      id: randomUUID(),
      aggregatorId: i.aggregatorId,
      mode: i.mode,
      targetRole: i.targetRole,
      label: i.label,
      joinCount: i.joinCount ?? 0,
      createdAt: new Date(),
      expiresAt: i.expiresAt ?? null,
      revokedAt: i.revokedAt ?? null,
    };
  }

  /** Lists non-revoked links for an aggregator, newest first. */
  async findActiveByAggregator(
    aggregatorId: string,
    paging?: Paging,
  ): Promise<Result<Paginated<OnboardingLinkEntity>, BaseError>> {
    const matched = [...this.store.values()]
      .filter((e) => e.aggregatorId === aggregatorId && e.revokedAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const limit = Math.min(paging?.limit ?? this.defaultLimit(), this.maxLimit());
    const items = matched.slice(0, limit);
    return ok({ items, total: matched.length });
  }

  /** Atomically increments joinCount for a link. */
  async incrementJoinCount(id: string): Promise<Result<OnboardingLinkEntity, BaseError>> {
    const existing = this.store.get(id);
    if (!existing) {
      return err(
        new UpstreamError('onboarding_link.incrementJoinCount: row not found', {
          code: 'DB_NOT_FOUND',
          details: { id },
        }),
      );
    }
    const updated = { ...existing, joinCount: existing.joinCount + 1 };
    this.store.set(id, updated);
    return ok(updated);
  }
}

export function buildOnboardingLink(
  overrides: Partial<OnboardingLinkEntity> = {},
): OnboardingLinkEntity {
  return {
    id: 'link-default',
    aggregatorId: 'agg-default',
    mode: 'link',
    targetRole: 'seeker',
    label: 'Default Link',
    joinCount: 0,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}
