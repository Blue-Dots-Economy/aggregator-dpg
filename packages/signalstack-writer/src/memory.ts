/**
 * In-memory SignalStackWriter — Map-backed, used by unit tests.
 *
 * Mirrors signalstack semantics as closely as a fake can:
 *   - User identity is shared (single row per phone OR email).
 *   - Profile rows are appended; uniqueness is NOT enforced (matches current
 *     server behaviour — no dedupe on items).
 *   - `aggregator_id` is recorded on create and immutable on update.
 *
 * Returned ids and timestamps are deterministic across the lifetime of the
 * writer to make assertions predictable.
 */

import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

import {
  SignalStackWriterBase,
  type SignalStackAggregator,
  type SignalStackItemList,
  type SignalStackItemQuery,
  type SignalStackOnboardInput,
  type SignalStackOnboardResult,
  type SignalStackProfile,
  type SignalStackUpsertAggregatorInput,
  type SignalStackUser,
} from './interface.js';

type StoredUser = SignalStackUser;

interface StoredProfile extends SignalStackProfile {
  created_by: string;
}

const ISO_FIXED = '2026-01-01T00:00:00.000Z';

export class InMemorySignalStackWriter extends SignalStackWriterBase {
  protected readonly users: Map<string, StoredUser> = new Map();
  protected readonly profiles: Map<string, StoredProfile> = new Map();
  /**
   * Aggregator org table keyed by `external_id` (our Postgres aggregator
   * UUID). Mirrors signalstack's dedupe key so repeated upserts with the
   * same input return the same `org_id` and never create duplicates.
   */
  protected readonly aggregators: Map<string, SignalStackAggregator> = new Map();
  private nextUserSeq = 1;
  private nextProfileSeq = 1;
  private nextAggregatorSeq = 1;

  override async onboard(
    input: SignalStackOnboardInput,
  ): Promise<Result<SignalStackOnboardResult, BaseError>> {
    if (!input?.user?.name) {
      return err(new UpstreamError('user.name is required', { code: 'SIGNALSTACK_INPUT_INVALID' }));
    }
    const email = normalizeEmail(input.user.email);
    const phone = normalizePhone(input.user.phoneNumber);
    if (!email && !phone) {
      return err(
        new UpstreamError('either user.email or user.phoneNumber is required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    const emailUser = email ? this.findByEmail(email) : undefined;
    const phoneUser = phone ? this.findByPhone(phone) : undefined;
    if (emailUser && phoneUser && emailUser.id !== phoneUser.id) {
      return err(
        new UpstreamError('email and phoneNumber map to different existing users', {
          code: 'SIGNALSTACK_CONFLICT',
        }),
      );
    }

    let userRow = emailUser ?? phoneUser;
    let userCreated = false;
    const userExisted = Boolean(userRow);

    if (!userRow) {
      if (input.profile?.item_id) {
        return err(
          new UpstreamError('item_id provided but user does not exist', {
            code: 'SIGNALSTACK_BAD_REQUEST',
          }),
        );
      }
      userRow = {
        id: `mem-user-${this.nextUserSeq++}`,
        name: input.user.name,
        email,
        phoneNumber: phone,
        role: 'user',
      };
      this.users.set(userRow.id, userRow);
      userCreated = true;
    }

    let profileCreated = false;
    let profileUpdated = false;

    if (input.profile) {
      if (input.profile.item_id) {
        const existing = this.profiles.get(input.profile.item_id);
        if (!existing) {
          return err(
            new UpstreamError('Profile with given item_id not found', {
              code: 'SIGNALSTACK_NOT_FOUND',
            }),
          );
        }
        if (existing.created_by !== userRow.id) {
          return err(
            new UpstreamError('item_id belongs to a different user', {
              code: 'SIGNALSTACK_FORBIDDEN',
            }),
          );
        }
        existing.item_state = input.profile.item_state ?? existing.item_state;
        existing.item_latitude = input.profile.item_latitude ?? existing.item_latitude;
        existing.item_longitude = input.profile.item_longitude ?? existing.item_longitude;
        existing.updated_at = ISO_FIXED;
        // aggregator_id is immutable on update — intentionally not touched.
        profileUpdated = true;
      } else {
        const id = `mem-item-${this.nextProfileSeq++}`;
        const profile: StoredProfile = {
          item_id: id,
          item_network: input.profile.item_network,
          item_domain: input.profile.item_domain,
          item_type: input.profile.item_type,
          item_state: input.profile.item_state ?? {},
          item_latitude: input.profile.item_latitude ?? null,
          item_longitude: input.profile.item_longitude ?? null,
          aggregator_id: input.aggregator_id ?? null,
          created_at: ISO_FIXED,
          updated_at: ISO_FIXED,
          created_by: userRow.id,
        };
        this.profiles.set(id, profile);
        profileCreated = true;
      }
    }

    const profiles = Array.from(this.profiles.values())
      .filter((p) => p.created_by === userRow.id)
      .map(stripCreatedBy);

    return ok({
      user: userRow,
      profiles,
      status: {
        userCreated,
        userExisted,
        profileCreated,
        profileUpdated,
        profileExisted: false,
      },
    });
  }

  override async listItemsByAggregator(
    query: SignalStackItemQuery,
  ): Promise<Result<SignalStackItemList, BaseError>> {
    if (!query.aggregator_id || !query.item_network || !query.item_domain) {
      return err(
        new UpstreamError('aggregator_id, item_network, and item_domain are required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    const matching = Array.from(this.profiles.values()).filter((p) => {
      if (p.aggregator_id !== query.aggregator_id) return false;
      if (p.item_network !== query.item_network) return false;
      if (p.item_domain !== query.item_domain) return false;
      if (query.item_type && p.item_type !== query.item_type) return false;
      return true;
    });
    const total = matching.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    const page = matching.slice(offset, offset + limit).map(stripCreatedBy);
    return ok({ meta: { total, limit, offset }, items: page });
  }

  /**
   * Deterministic Map-backed upsert. First call for an `external_id`
   * mints a new `mem-org-N` id and stores the row; subsequent calls update
   * `name`, `slug`, and `metadata` in place and return the same `org_id`.
   * Used by unit + cross-package consumer tests to assert against the
   * aggregator-approval flow without touching a real signalstack.
   *
   * @param input - external_id (our aggregator UUID) + display name + slug
   *   + optional metadata bag.
   * @returns ok(SignalStackAggregator) — same id on repeat calls;
   *   err(BaseError) only when a required input field is missing.
   */
  override async upsertAggregator(
    input: SignalStackUpsertAggregatorInput,
  ): Promise<Result<SignalStackAggregator, BaseError>> {
    if (!input?.external_id || !input?.name || !input?.slug) {
      return err(
        new UpstreamError('external_id, name, and slug are required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    const existing = this.aggregators.get(input.external_id);
    if (existing) {
      const updated: SignalStackAggregator = {
        ...existing,
        name: input.name,
        slug: input.slug,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      };
      this.aggregators.set(input.external_id, updated);
      return ok(updated);
    }
    const row: SignalStackAggregator = {
      org_id: `mem-org-${this.nextAggregatorSeq++}`,
      external_id: input.external_id,
      name: input.name,
      slug: input.slug,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    this.aggregators.set(input.external_id, row);
    return ok(row);
  }

  /** Test helper — current user table snapshot. */
  listUsers(): StoredUser[] {
    return Array.from(this.users.values());
  }

  /** Test helper — current profile table snapshot. */
  listProfiles(): StoredProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Snapshot of the in-memory aggregator table. Tests use this to assert
   * which upserts the approval flow dispatched without depending on the
   * fake's internal Map.
   *
   * @returns Array of stored aggregator rows in insertion order.
   */
  listAggregators(): SignalStackAggregator[] {
    return Array.from(this.aggregators.values());
  }

  protected findByEmail(email: string): StoredUser | undefined {
    for (const u of this.users.values()) {
      if (u.email === email) return u;
    }
    return undefined;
  }

  protected findByPhone(phone: string): StoredUser | undefined {
    for (const u of this.users.values()) {
      if (u.phoneNumber === phone) return u;
    }
    return undefined;
  }
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function stripCreatedBy(profile: StoredProfile): SignalStackProfile {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { created_by, ...rest } = profile;
  return rest;
}
