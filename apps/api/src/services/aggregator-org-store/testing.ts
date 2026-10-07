/**
 * Public testing surface for the aggregator-org store.
 *
 * Cross-module consumers import the fake from here, never the in-memory impl
 * directly (testing rule).
 */

import { InMemoryAggregatorOrgStore } from './memory.js';
import { contactId } from '@aggregator-dpg/shared-primitives/contact';
import { DEFAULT_ORG_SLUG, type AggregatorOrg } from './interface.js';
export { NO_CONSENT_WRITE } from '../consent-ledger/hook.js';

export class AggregatorOrgStoreFake extends InMemoryAggregatorOrgStore {
  /**
   * Pre-seed rows, bypassing create()'s slug check. Callers are responsible
   * for keeping seeded data internally consistent.
   *
   * @param rows - Rows to insert before the test runs.
   */
  seed(rows: AggregatorOrg[]): void {
    for (const r of rows) this.byId.set(r.id, r);
  }

  /**
   * Seeds the network-facilitator root (only `findRoot` returns it).
   *
   * @param row - The root org.
   */
  seedRoot(row: AggregatorOrg): void {
    this.root = row;
  }

  /** Reset between tests. */
  reset(): void {
    this.byId.clear();
    this.root = null;
  }
}

/**
 * Deterministic test data builder for an {@link AggregatorOrg}.
 *
 * @param overrides - Field overrides; defaults are valid and snapshot-stable.
 * @returns A fully-populated org row.
 */
export function buildAggregatorOrg(overrides: Partial<AggregatorOrg> = {}): AggregatorOrg {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  const ownerEmail = overrides.ownerEmail ?? 'owner@test.local';
  const ownerPhone = overrides.ownerPhone !== undefined ? overrides.ownerPhone : null;
  return {
    id: '00000000-0000-0000-0000-0000000000a1',
    slug: 'test-org',
    displayName: 'Test Org',
    state: null,
    contactId: contactId(ownerEmail, ownerPhone),
    // One admin account per owner person (0027): derived from the owner's
    // contact, so two orgs share an owner exactly when they share the person.
    ownerUserId: `owner-${contactId(ownerEmail, ownerPhone).slice(0, 16)}`,
    ownerEmail,
    ownerPhone,
    ownerName: null,
    ownerKcSub: null,
    kcGroupId: null,
    profile: {},
    profileRef: null,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    rejectedAt: null,
    isDefault: false,
    url: null,
    locations: [],
    legalName: null,
    gstNumber: null,
    ...overrides,
  };
}

/**
 * Builds the fixed Default org (0028): active, owned by the network admin.
 *
 * @param overrides - Field overrides.
 * @returns The Default org row.
 */
export function buildDefaultOrg(overrides: Partial<AggregatorOrg> = {}): AggregatorOrg {
  return buildAggregatorOrg({
    id: '00000000-0000-0000-0000-0000000000d0',
    slug: DEFAULT_ORG_SLUG,
    displayName: 'Default',
    ownerEmail: 'network-admin@nf.invalid',
    status: 'active',
    isDefault: true,
    ...overrides,
  });
}
