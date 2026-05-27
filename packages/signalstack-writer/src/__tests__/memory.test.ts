/**
 * Unit tests for InMemorySignalStackWriter and SignalStackWriterFake.
 *
 * These tests exercise the in-memory implementation directly (they live in the
 * same package, so using InMemorySignalStackWriter is correct here per
 * testing.md §5). SignalStackWriterFake is exercised for the seed/dashboard
 * pinning paths because the fake adds that surface.
 *
 * @module @aggregator-dpg/signalstack-writer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySignalStackWriter } from '../memory.js';
import { SignalStackWriterFake } from '../testing.js';
import type { SignalStackDashboardPage } from '../interface.js';

const ISO_FIXED = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// onboard()
// ---------------------------------------------------------------------------

describe('InMemorySignalStackWriter.onboard', () => {
  let writer: InMemorySignalStackWriter;

  beforeEach(() => {
    writer = new InMemorySignalStackWriter();
  });

  it('returns ok with deterministic ids on first call', async () => {
    const result = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha',
      phoneNumber: '+919876543210',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { occupation: 'carpenter' },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.user_id).toBe('mem-user-1');
    expect(result.value.profile_item_id).toBe('mem-item-1');
    expect(result.value.onboarded_at).toBe(ISO_FIXED);
  });

  it('re-uses the same user when phone matches', async () => {
    await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha',
      phoneNumber: '+919876543210',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    const second = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha Updated',
      phoneNumber: '+919876543210',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-2',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(second.success).toBe(true);
    if (!second.success) return;
    // Same user id, new profile id
    expect(second.value.user_id).toBe('mem-user-1');
    expect(second.value.profile_item_id).toBe('mem-item-2');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when actingOrgId is missing', async () => {
    const result = await writer.onboard({
      actingOrgId: '',
      name: 'Asha',
      email: 'asha@example.com',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when neither email nor phone is given', async () => {
    const result = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });

  it('returns SIGNALSTACK_CONFLICT when email and phone map to different users', async () => {
    await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha',
      phoneNumber: '+919876543210',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Priya',
      email: 'priya@example.com',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-2',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    // Attempt to onboard with phone from user-1 AND email from user-2
    const result = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Conflict',
      phoneNumber: '+919876543210',
      email: 'priya@example.com',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-3',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: {},
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_CONFLICT');
  });

  it('stores profiles accessible via listProfiles()', async () => {
    await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Asha',
      email: 'asha@example.com',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'bulk',
      source_id: 'upload-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { occupation: 'welder' },
    });

    expect(writer.listProfiles()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// listItemsByAggregator()
// ---------------------------------------------------------------------------

describe('InMemorySignalStackWriter.listItemsByAggregator', () => {
  let writer: InMemorySignalStackWriter;

  beforeEach(() => {
    writer = new InMemorySignalStackWriter();
  });

  it('returns only items matching the aggregator + network + domain', async () => {
    // Seed two profiles with different aggregator_id via the fake
    const fake = new SignalStackWriterFake();
    fake.seed({
      profiles: [
        {
          item_id: 'item-a',
          created_by: 'user-1',
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          aggregator_id: 'agg-1',
        },
        {
          item_id: 'item-b',
          created_by: 'user-2',
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          aggregator_id: 'agg-2',
        },
      ],
    });

    const result = await fake.listItemsByAggregator({
      aggregator_id: 'agg-1',
      item_network: 'blue_dot',
      item_domain: 'seeker',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0]!.item_id).toBe('item-a');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when aggregator_id is empty', async () => {
    const result = await writer.listItemsByAggregator({
      aggregator_id: '',
      item_network: 'blue_dot',
      item_domain: 'seeker',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });
});

// ---------------------------------------------------------------------------
// upsertAggregator()
// ---------------------------------------------------------------------------

describe('InMemorySignalStackWriter.upsertAggregator', () => {
  let writer: InMemorySignalStackWriter;

  beforeEach(() => {
    writer = new InMemorySignalStackWriter();
  });

  it('mints a new org_id on first call', async () => {
    const result = await writer.upsertAggregator({
      external_id: 'ext-1',
      name: 'Org One',
      slug: 'org-one',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.org_id).toBe('mem-org-1');
    expect(result.value.external_id).toBe('ext-1');
  });

  it('returns the same org_id on a repeated call with the same external_id', async () => {
    await writer.upsertAggregator({ external_id: 'ext-1', name: 'Org One', slug: 'org-one' });
    const second = await writer.upsertAggregator({
      external_id: 'ext-1',
      name: 'Org One Updated',
      slug: 'org-one-v2',
    });

    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.value.org_id).toBe('mem-org-1');
    expect(second.value.name).toBe('Org One Updated');
    expect(second.value.slug).toBe('org-one-v2');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when external_id is missing', async () => {
    const result = await writer.upsertAggregator({ external_id: '', name: 'Test', slug: 'test' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });
});

// ---------------------------------------------------------------------------
// fetchDashboard() — canonical new shape (emptyDomainSlice)
// ---------------------------------------------------------------------------

describe('InMemorySignalStackWriter.fetchDashboard — canonical empty shape', () => {
  it('synthesises seeker and provider slices with the new rollup shape', async () => {
    const writer = new InMemorySignalStackWriter();
    const result = await writer.fetchDashboard({ actingOrgId: 'org-x' });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Both domains are present
    expect(result.value.by_domain['seeker']).toBeDefined();
    expect(result.value.by_domain['provider']).toBeDefined();

    // Validate new rollup shape for seeker
    const slice = result.value.by_domain['seeker']!;
    expect(Array.isArray(slice.items)).toBe(true);
    expect(slice.items).toEqual([]);
    expect(slice.rollup).toEqual({
      total_items: 0,
      complete_profiles: 0,
      has_applications: 0,
      by_status: { new: 0, active: 0, at_risk: 0, inactive: 0 },
      by_action_status: { create: 0, accept: 0, reject: 0, cancel: 0 },
      avg_items_per_user: 0,
      avg_actions_per_user: 0,
      mode_wise_counts: {},
    });
    expect(slice.total_matching).toBe(0);
    expect(slice.next_cursor).toBeNull();

    // Metadata present
    expect(result.value.metadata.last_computed_at).toBe(ISO_FIXED);
    expect(result.value.metadata.ttl_seconds).toBe(3600);
  });

  it('returns SIGNALSTACK_INPUT_INVALID when actingOrgId is missing', async () => {
    const writer = new InMemorySignalStackWriter();
    const result = await writer.fetchDashboard({ actingOrgId: '' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });
});

// ---------------------------------------------------------------------------
// fetchDashboard() — pinned payload via SignalStackWriterFake.seed()
// ---------------------------------------------------------------------------

describe('SignalStackWriterFake.seed — pinned dashboard', () => {
  it('returns the pinned page for the matching actingOrgId', async () => {
    const fake = new SignalStackWriterFake();

    const pinnedPage: SignalStackDashboardPage = {
      by_domain: {
        seeker: {
          rollup: {
            total_items: 10,
            complete_profiles: 7,
            has_applications: 4,
            by_status: { new: 2, active: 6, at_risk: 1, inactive: 1 },
            by_action_status: { create: 10, accept: 8, reject: 2, cancel: 0 },
            avg_items_per_user: 2.0,
            avg_actions_per_user: 4.0,
            mode_wise_counts: { bulk: 3, link: 7 },
          },
          items: [
            {
              name: 'Priya',
              item_network: 'blue_dot',
              item_domain: 'seeker',
              item_type: 'profile_1.0',
              onboarded_via: 'bulk',
              profile_status: 'new',
              profile_completion_pct: 60,
              profile_created_at: '2026-03-01T00:00:00Z',
              profile_last_updated_at: '2026-03-02T00:00:00Z',
              age_days: 10,
              count_create: 1,
              count_accept: 0,
              count_reject: 0,
              count_cancel: 0,
              last_create_at: '2026-03-01T00:00:00Z',
              last_accept_at: null,
              last_reject_at: null,
              last_cancel_at: null,
              actionable_tags: ['incomplete_profile'],
            },
          ],
          total_matching: 10,
          next_cursor: null,
        },
      },
      metadata: {
        last_computed_at: '2026-03-01T00:00:00Z',
        ttl_seconds: 3600,
        refreshed: true,
      },
    };

    fake.seed({
      dashboards: [{ acting_org_id: 'org-pinned', page: pinnedPage }],
    });

    const result = await fake.fetchDashboard({ actingOrgId: 'org-pinned' });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const slice = result.value.by_domain['seeker']!;
    expect(slice.rollup.total_items).toBe(10);
    expect(slice.rollup.complete_profiles).toBe(7);
    expect(slice.rollup.has_applications).toBe(4);
    expect(slice.rollup.by_status).toEqual({ new: 2, active: 6, at_risk: 1, inactive: 1 });
    expect(slice.rollup.by_action_status).toEqual({ create: 10, accept: 8, reject: 2, cancel: 0 });
    expect(slice.rollup.mode_wise_counts).toEqual({ bulk: 3, link: 7 });
    expect(slice.items).toHaveLength(1);
    expect((slice.items[0] as Record<string, unknown>)['name']).toBe('Priya');
    expect(result.value.metadata.refreshed).toBe(true);
  });

  it('falls back to the synthesised empty shape for an unregistered actingOrgId', async () => {
    const fake = new SignalStackWriterFake();

    const result = await fake.fetchDashboard({ actingOrgId: 'org-not-seeded' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.by_domain['seeker']!.rollup.total_items).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// exportDashboardCsv()
// ---------------------------------------------------------------------------

describe('SignalStackWriterFake.seed — pinned csv export', () => {
  it('returns the pinned csv string', async () => {
    const fake = new SignalStackWriterFake();
    const csv = 'name,status\nAsha,active\nPriya,new';
    fake.seed({ dashboardExports: [{ acting_org_id: 'org-1', csv }] });

    const result = await fake.exportDashboardCsv({ actingOrgId: 'org-1' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.csv).toBe(csv);
    expect(result.value.filename).toMatch(/^aggregator-dashboard-all-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('uses status in the generated filename when status filter is set', async () => {
    const fake = new SignalStackWriterFake();
    fake.seed({ dashboardExports: [{ acting_org_id: 'org-1', csv: 'name,status\nAsha,active' }] });

    const result = await fake.exportDashboardCsv({ actingOrgId: 'org-1', status: 'active' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.filename).toContain('active');
  });

  it('returns SIGNALSTACK_BAD_RESPONSE when no csv is seeded', async () => {
    const fake = new SignalStackWriterFake();

    const result = await fake.exportDashboardCsv({ actingOrgId: 'org-no-csv' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
  });

  it('returns SIGNALSTACK_INPUT_INVALID when actingOrgId is missing', async () => {
    const fake = new SignalStackWriterFake();

    const result = await fake.exportDashboardCsv({ actingOrgId: '' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
  });
});
