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
import type { SignalStackDashboardPage } from './interface.js';

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
  /**
   * Signalstack organisation id the row is scoped under. Optional in
   * seeds — defaults to an empty string so tests that don't care about
   * onboard-channel attribution stay terse.
   */
  acting_org_id?: string;
  /** Channel attribution; defaults to `'bulk'`. */
  channel?: 'bulk' | 'link';
  /** Source workflow id; defaults to empty string. */
  source_id?: string;
}

/**
 * Pre-built signalstack aggregator row for `seed()`.
 *
 * Passing `org_id` lets a test pin the value the aggregator-approval flow
 * will read back; leaving it unset triggers the fake's `seed-org-N`
 * counter, which is sufficient for tests that only care that *some* id was
 * resolved.
 */
export interface SignalStackAggregatorSeed {
  org_id?: string;
  external_id: string;
  name: string;
  slug: string;
  metadata?: Record<string, unknown>;
}

/**
 * Pre-built dashboard payload keyed by `acting_org_id`. Tests use this
 * to pin the rollup the writer's {@link InMemorySignalStackWriter.fetchDashboard}
 * returns for a given aggregator org. Without a pinned response the
 * fake synthesises a deterministic empty rollup.
 */
export interface SignalStackDashboardSeed {
  acting_org_id: string;
  page: SignalStackDashboardPage;
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
  seed(seeds: {
    users?: SignalStackUserSeed[];
    profiles?: SignalStackProfileSeed[];
    aggregators?: SignalStackAggregatorSeed[];
    dashboards?: SignalStackDashboardSeed[];
  }): void {
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
        acting_org_id: s.acting_org_id ?? '',
        channel: s.channel ?? 'bulk',
        source_id: s.source_id ?? '',
      });
    }

    let aggregatorCounter = 1;
    for (const s of seeds.aggregators ?? []) {
      const orgId = s.org_id ?? `seed-org-${aggregatorCounter++}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).aggregators.set(s.external_id, {
        org_id: orgId,
        external_id: s.external_id,
        name: s.name,
        slug: s.slug,
        ...(s.metadata !== undefined ? { metadata: s.metadata } : {}),
      });
    }

    for (const s of seeds.dashboards ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).dashboards.set(s.acting_org_id, s.page);
    }
  }
}
