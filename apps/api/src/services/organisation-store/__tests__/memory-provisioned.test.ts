import { describe, expect, it } from 'vitest';
import { InMemoryOrganisationStore } from '../memory.js';
import { permissiveTreeRules } from '../testing.js';
import type { CreateOrgInput } from '../interface.js';

const base = { slug: 'acme', displayName: 'Acme', ownerEmail: 'o@acme.org' };

describe('InMemoryOrganisationStore.create without a consent hook', () => {
  it('creates a provisioned org and records who provisioned it', async () => {
    const store = new InMemoryOrganisationStore();
    const input: CreateOrgInput = {
      ...base,
      createdBy: 'provisioned:ops',
      recordConsent: undefined,
    };
    const r = await store.create(input, permissiveTreeRules());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.updatedBy).toBe('provisioned:ops');
    expect(r.value.createdBy).toBe('provisioned:ops');
    const read = await store.findById(r.value.id);
    expect(read.ok && read.value?.createdBy).toBe('provisioned:ops');
  });

  it('returns CONSENT_REQUIRED for a self-created org and stores nothing', async () => {
    const store = new InMemoryOrganisationStore();
    const r = await store.create(
      { ...base, createdBy: 'self', recordConsent: undefined },
      permissiveTreeRules(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONSENT_REQUIRED');
    const found = await store.findBySlug('acme');
    expect(found.ok && found.value).toBeNull();
  });

  it('defaults createdBy to self, so no hook is refused', async () => {
    const store = new InMemoryOrganisationStore();
    const r = await store.create({ ...base }, permissiveTreeRules());
    expect(!r.ok && r.error.code).toBe('CONSENT_REQUIRED');
  });
});
