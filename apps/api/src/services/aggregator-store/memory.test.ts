/**
 * Unit tests for the in-memory aggregator store.
 *
 * Asserts the contract every adapter must satisfy: create returns a row with
 * a generated id; duplicate slug fails; lookups round-trip; delete removes
 * both id + slug indexes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAggregatorStore } from './memory.js';
import { AggregatorStoreFake, buildAggregator } from './testing.js';

describe('InMemoryAggregatorStore', () => {
  let store: InMemoryAggregatorStore;

  beforeEach(() => {
    store = new InMemoryAggregatorStore();
  });

  describe('create', () => {
    it('inserts a new aggregator with a generated id', async () => {
      const result = await store.create({ orgSlug: 'org-a', type: 'seeker' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result.value.orgSlug).toBe('org-a');
      expect(result.value.type).toBe('seeker');
    });

    it('rejects duplicate slug', async () => {
      await store.create({ orgSlug: 'dup', type: 'seeker' });
      const second = await store.create({ orgSlug: 'dup', type: 'provider' });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe('DUPLICATE_SLUG');
    });
  });

  describe('findById', () => {
    it('returns the aggregator', async () => {
      const created = await store.create({ orgSlug: 'org-b', type: 'provider' });
      if (!created.ok) throw new Error('seed failed');
      const found = await store.findById(created.value.id);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value?.id).toBe(created.value.id);
    });

    it('returns null when not found', async () => {
      const found = await store.findById('00000000-0000-0000-0000-000000000999');
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value).toBeNull();
    });
  });

  describe('findBySlug', () => {
    it('returns the aggregator by slug', async () => {
      await store.create({ orgSlug: 'org-c', type: 'seeker' });
      const found = await store.findBySlug('org-c');
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value?.orgSlug).toBe('org-c');
    });

    it('returns null when slug missing', async () => {
      const found = await store.findBySlug('nope');
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value).toBeNull();
    });
  });

  describe('deleteById', () => {
    it('removes the aggregator and its slug index', async () => {
      const created = await store.create({ orgSlug: 'org-d', type: 'seeker' });
      if (!created.ok) throw new Error('seed failed');
      const deleted = await store.deleteById(created.value.id);
      expect(deleted.ok).toBe(true);

      const byId = await store.findById(created.value.id);
      const bySlug = await store.findBySlug('org-d');
      if (byId.ok && bySlug.ok) {
        expect(byId.value).toBeNull();
        expect(bySlug.value).toBeNull();
      }
    });

    it('errors when id is missing', async () => {
      const result = await store.deleteById('00000000-0000-0000-0000-000000000999');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  describe('AggregatorStoreFake', () => {
    it('seeds rows that subsequent lookups can find', async () => {
      const fake = new AggregatorStoreFake();
      const seed = buildAggregator({
        id: '00000000-0000-0000-0000-000000000abc',
        orgSlug: 'seed-1',
      });
      fake.seed([seed]);
      const found = await fake.findById(seed.id);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value?.orgSlug).toBe('seed-1');
    });

    it('reset() clears state', async () => {
      const fake = new AggregatorStoreFake();
      fake.seed([buildAggregator()]);
      fake.reset();
      const found = await fake.findById(buildAggregator().id);
      if (found.ok) expect(found.value).toBeNull();
    });
  });
});
