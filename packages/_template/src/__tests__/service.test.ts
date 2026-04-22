import { describe, it, expect, beforeEach } from 'vitest';
import { ServiceFake } from '../testing/index.js';
import type { TemplateItem } from '../interface.js';

const makeItem = (overrides: Partial<TemplateItem> = {}): TemplateItem => ({
  id: 'item-1',
  name: 'Test Item',
  createdAt: new Date('2024-01-01'),
  ...overrides,
});

describe('ServiceFake', () => {
  let svc: ServiceFake;

  beforeEach(() => {
    svc = new ServiceFake();
  });

  describe('findById', () => {
    it('returns Ok with item when it exists', async () => {
      svc.seed([makeItem()]);
      const result = await svc.findById('item-1');
      expect(result.success).toBe(true);
      if (result.success) expect(result.value.name).toBe('Test Item');
    });

    it('returns Err when item does not exist', async () => {
      const result = await svc.findById('missing');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  describe('save', () => {
    it('persists item and returns Ok with createdAt set', async () => {
      const result = await svc.save({ id: 'new-1', name: 'New' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.id).toBe('new-1');
        expect(result.value.createdAt).toBeInstanceOf(Date);
      }
    });

    it('saved item is retrievable via findById', async () => {
      await svc.save({ id: 'new-2', name: 'Saved' });
      const result = await svc.findById('new-2');
      expect(result.success).toBe(true);
    });

    it('overwrites existing item on same id', async () => {
      svc.seed([makeItem({ name: 'Old' })]);
      await svc.save({ id: 'item-1', name: 'Updated' });
      const result = await svc.findById('item-1');
      expect(result.success && result.value.name).toBe('Updated');
    });
  });

  describe('delete', () => {
    it('returns Ok and removes item', async () => {
      svc.seed([makeItem()]);
      const result = await svc.delete('item-1');
      expect(result.success).toBe(true);
      const find = await svc.findById('item-1');
      expect(find.success).toBe(false);
    });

    it('returns Err when item does not exist', async () => {
      const result = await svc.delete('ghost');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  describe('seed', () => {
    it('seeds multiple items', async () => {
      svc.seed([makeItem({ id: 'a' }), makeItem({ id: 'b' })]);
      expect((await svc.findById('a')).success).toBe(true);
      expect((await svc.findById('b')).success).toBe(true);
    });
  });
});
