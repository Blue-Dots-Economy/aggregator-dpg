/**
 * Unit tests for the in-memory aggregator profile store.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAggregatorProfileStore } from './memory.js';
import {
  AggregatorProfileStoreFake,
  buildAggregatorProfile,
  buildCreateAggregatorProfileInput,
} from './testing.js';

describe('InMemoryAggregatorProfileStore', () => {
  let store: InMemoryAggregatorProfileStore;
  const aggregatorId = '00000000-0000-0000-0000-000000000abc';

  beforeEach(() => {
    store = new InMemoryAggregatorProfileStore();
  });

  describe('create', () => {
    it('inserts an empty profile row', async () => {
      const result = await store.create(buildCreateAggregatorProfileInput({ aggregatorId }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.aggregatorId).toBe(aggregatorId);
      expect(result.value.schemaVersion).toBe(1);
      expect(result.value.data).toEqual({});
      expect(result.value.consent).toEqual({});
    });

    it('rejects duplicate insert for same aggregatorId', async () => {
      await store.create(buildCreateAggregatorProfileInput({ aggregatorId }));
      const second = await store.create(buildCreateAggregatorProfileInput({ aggregatorId }));
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe('DUPLICATE');
    });

    it('uses defaults for missing optional fields', async () => {
      const result = await store.create({
        aggregatorId,
        createdBy: 'admin',
        updatedBy: 'admin',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.schemaVersion).toBe(1);
      expect(result.value.data).toEqual({});
    });
  });

  describe('findByAggregatorId', () => {
    it('returns the profile', async () => {
      await store.create(buildCreateAggregatorProfileInput({ aggregatorId }));
      const found = await store.findByAggregatorId(aggregatorId);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value?.aggregatorId).toBe(aggregatorId);
    });

    it('returns null when missing', async () => {
      const found = await store.findByAggregatorId(aggregatorId);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value).toBeNull();
    });
  });

  describe('update', () => {
    it('merges partial updates and bumps updatedBy', async () => {
      await store.create(buildCreateAggregatorProfileInput({ aggregatorId }));
      const updated = await store.update(aggregatorId, {
        data: { name: 'BlueDots' },
        updatedBy: 'user-123',
      });
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value.data).toEqual({ name: 'BlueDots' });
      expect(updated.value.updatedBy).toBe('user-123');
      expect(updated.value.consent).toEqual({});
    });

    it('errors when profile is missing', async () => {
      const result = await store.update(aggregatorId, { updatedBy: 'x', data: {} });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  describe('AggregatorProfileStoreFake', () => {
    it('seed + reset', async () => {
      const fake = new AggregatorProfileStoreFake();
      fake.seed([buildAggregatorProfile({ aggregatorId })]);
      const found = await fake.findByAggregatorId(aggregatorId);
      if (found.ok) expect(found.value?.aggregatorId).toBe(aggregatorId);
      fake.reset();
      const after = await fake.findByAggregatorId(aggregatorId);
      if (after.ok) expect(after.value).toBeNull();
    });
  });
});
