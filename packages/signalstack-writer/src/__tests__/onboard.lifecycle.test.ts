/**
 * Unit tests for SignalStackWriterFake.onboard — lifecycle response shape.
 *
 * Covers the lifecycle-classification fields added in Task 4 of the
 * onboarding lifecycle follow-up plan:
 *   - default classification (no nextClassification, no foreign-user, default
 *     submit_mode) returns `lifecycle_status: 'live'` and
 *     `owned_elsewhere: false`.
 *   - `setNextClassification` consumes a pinned draft/partial classification
 *     once and reverts to the default on the next call.
 *   - `seedForeignUser` causes the next onboard for that email/phone to
 *     return `owned_elsewhere: true` with an empty `profile_item_id` and
 *     no lifecycle fields.
 *   - `submit_mode: 'account_only'` skips the item-creation path and omits
 *     the lifecycle fields entirely.
 *
 * @module @aggregator-dpg/signalstack-writer
 */

import { describe, it, expect } from 'vitest';
import { SignalStackWriterFake, buildOnboardInput } from '../testing.js';

describe('SignalStackWriterFake.onboard — lifecycle response shape', () => {
  it('returns live on default classification', async () => {
    const fake = new SignalStackWriterFake();
    const res = await fake.onboard(buildOnboardInput({ submit_mode: 'with_item' }));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.value.lifecycle_status).toBe('live');
      expect(res.value.owned_elsewhere ?? false).toBe(false);
    }
  });

  it('returns draft when next classification is set', async () => {
    const fake = new SignalStackWriterFake();
    fake.setNextClassification({ lifecycle_status: 'draft' });
    const res = await fake.onboard(buildOnboardInput({ submit_mode: 'with_item' }));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.value.lifecycle_status).toBe('draft');
    }
  });

  it('returns owned_elsewhere=true with empty profile_item_id when foreign-user is seeded by email', async () => {
    const fake = new SignalStackWriterFake();
    fake.seedForeignUser({ email: 'foreigner@example.com' });
    const res = await fake.onboard(buildOnboardInput({ email: 'foreigner@example.com' }));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.value.owned_elsewhere).toBe(true);
      expect(res.value.profile_item_id).toBe('');
      expect(res.value.lifecycle_status).toBeUndefined();
    }
  });

  it('omits lifecycle_status entirely on account_only submit_mode', async () => {
    const fake = new SignalStackWriterFake();
    const res = await fake.onboard(buildOnboardInput({ submit_mode: 'account_only' }));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.value.lifecycle_status).toBeUndefined();
      expect(res.value.profile_item_id).toBe('');
    }
  });
});
