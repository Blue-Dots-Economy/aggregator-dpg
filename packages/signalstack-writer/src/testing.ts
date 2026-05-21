/**
 * Testing fake for SignalStackWriterBase.
 *
 * Consumers in other packages (apps/api, apps/worker, services/*) import
 * this fake from `@aggregator-dpg/signalstack-writer/testing` rather than
 * reaching into `./memory`. Adds a `seed()` helper for arrange-act-assert
 * tests so cases that need a pre-existing signalstack user / profile don't
 * have to make extra `onboard()` calls.
 */

import { InMemorySignalStackWriter } from './memory.js';

export { InMemorySignalStackWriter };

export interface SignalStackUserSeed {
  id?: string;
  name: string;
  email?: string | null;
  phoneNumber?: string | null;
  role?: string | null;
}

export interface SignalStackProfileSeed {
  item_id?: string;
  created_by: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state?: Record<string, unknown>;
  item_latitude?: number | null;
  item_longitude?: number | null;
  aggregator_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

const ISO_FIXED = '2026-01-01T00:00:00.000Z';

export class SignalStackWriterFake extends InMemorySignalStackWriter {
  /**
   * Inserts the given users + profiles directly into the underlying store,
   * bypassing the `onboard()` method. Useful when a test needs an existing
   * signalstack user (e.g., to exercise the userExisted branch) or profile
   * (to exercise update / ownership-mismatch branches).
   *
   * Re-seeding the same user.id or profile.item_id overwrites the previous
   * row.
   */
  seed(seeds: { users?: SignalStackUserSeed[]; profiles?: SignalStackProfileSeed[] }): void {
    let userCounter = 1;
    for (const s of seeds.users ?? []) {
      const id = s.id ?? `seed-user-${userCounter++}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).users.set(id, {
        id,
        name: s.name,
        email: s.email ?? null,
        phoneNumber: s.phoneNumber ?? null,
        role: s.role ?? 'user',
      });
    }

    let profileCounter = 1;
    for (const s of seeds.profiles ?? []) {
      const id = s.item_id ?? `seed-item-${profileCounter++}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).profiles.set(id, {
        item_id: id,
        item_network: s.item_network,
        item_domain: s.item_domain,
        item_type: s.item_type,
        item_state: s.item_state ?? {},
        item_latitude: s.item_latitude ?? null,
        item_longitude: s.item_longitude ?? null,
        aggregator_id: s.aggregator_id ?? null,
        created_at: s.created_at ?? ISO_FIXED,
        updated_at: s.updated_at ?? ISO_FIXED,
        created_by: s.created_by,
      });
    }
  }
}
