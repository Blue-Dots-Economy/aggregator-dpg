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
  type SignalStackOnboardInput,
  type SignalStackOnboardResult,
  type SignalStackProfile,
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
  private nextUserSeq = 1;
  private nextProfileSeq = 1;

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

  /** Test helper — current user table snapshot. */
  listUsers(): StoredUser[] {
    return Array.from(this.users.values());
  }

  /** Test helper — current profile table snapshot. */
  listProfiles(): StoredProfile[] {
    return Array.from(this.profiles.values());
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
