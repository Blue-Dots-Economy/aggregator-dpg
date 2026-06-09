/**
 * Unit tests for SignalStackWriterFake.probeUser — identity-only lookup
 * primitive.
 *
 * Covers Task 5 of the onboarding lifecycle follow-up plan:
 *   - A truly new email returns `user_exists: false` with no lifecycle leak.
 *   - An own user (seeded via {@link InMemorySignalStackWriter.seedOwnUser})
 *     returns lifecycle_summary populated from the seeded primary item.
 *   - A foreign-owned user returns `owned_elsewhere: true` with a null
 *     lifecycle_summary so the calling aggregator never sees another org's
 *     state.
 *   - Missing both email and phoneNumber surfaces a validation failure
 *     rather than a silent success.
 *   - Phone-only lookup still matches an own user seeded by phoneNumber.
 *
 * @module @aggregator-dpg/signalstack-writer
 */

import { describe, it, expect } from 'vitest';
import { SignalStackWriterFake } from '../testing.js';

describe('SignalStackWriterFake.probeUser', () => {
  it('reports a new email as not yet existing', async () => {
    const fake = new SignalStackWriterFake();
    const res = await fake.probeUser({
      actingOrgId: 'org-1',
      email: 'new@example.com',
      network: 'blue_dot',
      domain: 'seeker',
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.value.user_exists).toBe(false);
      expect(res.value.owned_elsewhere).toBe(false);
      expect(res.value.lifecycle_summary).toBeNull();
    }
  });

  it('reports an own draft user with completion %', async () => {
    const fake = new SignalStackWriterFake();
    fake.seedOwnUser({
      actingOrgId: 'org-1',
      email: 'a@b.com',
      item: { item_id: 'item-1', lifecycle_status: 'draft' },
    });
    const res = await fake.probeUser({
      actingOrgId: 'org-1',
      email: 'a@b.com',
      network: 'blue_dot',
      domain: 'seeker',
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.value.user_exists).toBe(true);
      expect(res.value.owned_elsewhere).toBe(false);
      expect(res.value.lifecycle_summary?.primary_item.lifecycle_status).toBe('draft');
      expect(res.value.lifecycle_summary?.primary_item.item_id).toBe('item-1');
    }
  });

  it('reports owned_elsewhere with no lifecycle leak', async () => {
    const fake = new SignalStackWriterFake();
    fake.seedForeignUser({ email: 'shared@x.com' });
    const res = await fake.probeUser({
      actingOrgId: 'org-1',
      email: 'shared@x.com',
      network: 'blue_dot',
      domain: 'seeker',
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.value.user_exists).toBe(true);
      expect(res.value.owned_elsewhere).toBe(true);
      expect(res.value.lifecycle_summary).toBeNull();
    }
  });

  it('returns a ValidationError when both email and phoneNumber are absent', async () => {
    const fake = new SignalStackWriterFake();
    const res = await fake.probeUser({
      actingOrgId: 'org-1',
      network: 'blue_dot',
      domain: 'seeker',
    } as never);
    expect(res.success).toBe(false);
  });

  it('matches by phoneNumber when email is absent', async () => {
    const fake = new SignalStackWriterFake();
    fake.seedOwnUser({
      actingOrgId: 'org-1',
      phoneNumber: '+918888888888',
      item: { item_id: 'item-2', lifecycle_status: 'live' },
    });
    const res = await fake.probeUser({
      actingOrgId: 'org-1',
      phoneNumber: '+918888888888',
      network: 'blue_dot',
      domain: 'seeker',
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.value.user_exists).toBe(true);
      expect(res.value.lifecycle_summary?.primary_item.item_id).toBe('item-2');
    }
  });
});
