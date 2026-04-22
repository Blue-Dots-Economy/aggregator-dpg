import { describe, it, expect, beforeEach } from 'vitest';
import { ServiceFake, buildTemplateItem } from '../testing/index.js';

describe('ServiceFake', () => {
  let svc: ServiceFake;

  beforeEach(() => {
    svc = new ServiceFake();
  });

  describe('findById', () => {
    it('returns Ok with item when it exists', async () => {
      svc.seed([buildTemplateItem()]);
      const result = await svc.findById('item-default');
      expect(result.success).toBe(true);
      if (result.success) expect(result.value.name).toBe('Default Item');
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
      svc.seed([buildTemplateItem({ name: 'Old' })]);
      await svc.save({ id: 'item-default', name: 'Updated' });
      const result = await svc.findById('item-default');
      expect(result.success && result.value.name).toBe('Updated');
    });
  });

  describe('delete', () => {
    it('returns Ok and removes item', async () => {
      svc.seed([buildTemplateItem()]);
      const result = await svc.delete('item-default');
      expect(result.success).toBe(true);
      const find = await svc.findById('item-default');
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
      svc.seed([buildTemplateItem({ id: 'a' }), buildTemplateItem({ id: 'b' })]);
      expect((await svc.findById('a')).success).toBe(true);
      expect((await svc.findById('b')).success).toBe(true);
    });
  });
});
