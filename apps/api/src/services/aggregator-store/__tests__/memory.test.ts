/**
 * Unit tests for the in-memory aggregator store's contact rules
 * (`@aggregator-dpg/api`): one person per email and per phone, a canonical
 * phone (the Postgres store's CHECK), and NOT_FOUND on unknown ids — the same
 * outcomes the Postgres adapter reports, so route tests built on the fake see
 * real behaviour.
 */
import { describe, expect, it } from 'vitest';
import { contactId } from '@aggregator-dpg/shared-primitives/contact';
import { InMemoryAggregatorStore } from '../memory.js';
import { buildCreateAggregatorInput } from '../testing.js';

const contactOf = (email: string, phone: string) => ({ name: 'Asha', email, phone });

/** A store holding one coordinator (`a@x.org`, `+919000000001`); returns its id. */
async function seeded(): Promise<{ store: InMemoryAggregatorStore; id: string }> {
  const store = new InMemoryAggregatorStore();
  const r = await store.create(
    buildCreateAggregatorInput({ orgSlug: 'one', contact: contactOf('a@x.org', '+919000000001') }),
  );
  if (!r.ok) throw new Error('seed failed');
  return { store, id: r.value.id };
}

describe('InMemoryAggregatorStore.create', () => {
  it('stores the contact id, lowercased email and phone', async () => {
    const { store, id } = await seeded();
    const found = await store.findById(id);
    expect(found.ok && found.value?.contactId).toBe(contactId('a@x.org', '+919000000001'));
    expect(found.ok && found.value?.contactEmail).toBe('a@x.org');
  });

  it.each([
    ['DUPLICATE_SLUG', { orgSlug: 'one', contact: contactOf('b@x.org', '+919000000002') }],
    ['DUPLICATE_PHONE', { orgSlug: 'two', contact: contactOf('b@x.org', '+919000000001') }],
    ['DUPLICATE_EMAIL', { orgSlug: 'two', contact: contactOf('A@X.org', '+919000000002') }],
    ['CHECK_VIOLATION', { orgSlug: 'two', contact: contactOf('b@x.org', '9000000002') }],
  ] as const)('returns %s', async (code, overrides) => {
    const { store } = await seeded();
    const r = await store.create(buildCreateAggregatorInput(overrides));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });
});

describe('InMemoryAggregatorStore lookups', () => {
  it('returns null for an unknown slug, phone or email', async () => {
    const { store } = await seeded();
    expect(await store.findBySlug('nope')).toEqual({ ok: true, value: null });
    expect(await store.findByContactPhone('+919999999999')).toEqual({ ok: true, value: null });
    expect(await store.findByContactEmail('nobody@x.org')).toEqual({ ok: true, value: null });
  });

  it('finds by email case-insensitively', async () => {
    const { store, id } = await seeded();
    const r = await store.findByContactEmail('A@X.ORG');
    expect(r.ok && r.value?.id).toBe(id);
  });
});

describe('InMemoryAggregatorStore.update', () => {
  it('re-derives the contact id when the phone changes', async () => {
    const { store, id } = await seeded();
    const r = await store.update(id, {
      contact: contactOf('a@x.org', '+919000000003'),
      updatedBy: 't',
    });
    expect(r.ok && r.value.contactId).toBe(contactId('a@x.org', '+919000000003'));
    expect(await store.findByContactPhone('+919000000001')).toEqual({ ok: true, value: null });
  });

  it.each([
    ['DUPLICATE_PHONE', contactOf('a@x.org', '+919000000002')],
    ['DUPLICATE_EMAIL', contactOf('b@x.org', '+919000000001')],
    ['CHECK_VIOLATION', contactOf('a@x.org', '12345')],
  ] as const)('returns %s', async (code, next) => {
    const { store, id } = await seeded();
    await store.create(
      buildCreateAggregatorInput({
        orgSlug: 'two',
        contact: contactOf('b@x.org', '+919000000002'),
      }),
    );
    const r = await store.update(id, { contact: next, updatedBy: 't' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it('returns NOT_FOUND for an unknown id on every write', async () => {
    const store = new InMemoryAggregatorStore();
    const update = await store.update('missing', { name: 'x', updatedBy: 't' });
    const stamp = await store.updateSignalstackOrgId('missing', 'org_1', 't');
    const del = await store.deleteById('missing');
    for (const r of [update, stamp, del]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
    }
  });
});
