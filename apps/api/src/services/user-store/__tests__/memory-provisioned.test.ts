import { describe, expect, it } from 'vitest';
import { InMemoryUserStore } from '../memory.js';
import { buildCreateCoordinatorInput } from '../testing.js';

describe('InMemoryUserStore.create without a consent hook', () => {
  it('creates a provisioned coordinator with no consent', async () => {
    const store = new InMemoryUserStore();
    const r = await store.create(
      buildCreateCoordinatorInput({
        createdBy: 'provisioned:ops',
        updatedBy: 'provisioned:ops',
        recordConsent: undefined,
        consent: undefined,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.createdBy).toBe('provisioned:ops');
      expect(r.value.consent).toBeNull();
    }
  });

  it('returns CONSENT_REQUIRED for any other creator and stores nothing', async () => {
    const store = new InMemoryUserStore();
    const input = buildCreateCoordinatorInput({ createdBy: 'self', recordConsent: undefined });
    const r = await store.create(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONSENT_REQUIRED');
    const found = await store.findBySlug(input.orgSlug);
    expect(found.ok && found.value).toBeNull();
  });
});
