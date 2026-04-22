import { describe, it, expect } from 'vitest';
import {
  TimestampsSchema,
  CursorSchema,
  paginatedSchema,
  PagingSchema,
  SortSchema,
  FilterConditionSchema,
  FilterSchema,
  FilterOperatorSchema,
  SortDirectionSchema,
} from '../dto/index.js';
import { z } from 'zod';

describe('TimestampsSchema', () => {
  it('parses ISO date strings', () => {
    const ts = TimestampsSchema.parse({
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-06-15T12:00:00Z',
    });
    expect(ts.createdAt).toBeInstanceOf(Date);
    expect(ts.updatedAt).toBeInstanceOf(Date);
  });

  it('passes through Date objects', () => {
    const now = new Date();
    const ts = TimestampsSchema.parse({ createdAt: now, updatedAt: now });
    expect(ts.createdAt.getTime()).toBe(now.getTime());
  });

  it('rejects invalid dates', () => {
    expect(() => TimestampsSchema.parse({ createdAt: 'not-a-date', updatedAt: '2024' })).toThrow();
  });
});

describe('CursorSchema', () => {
  it('parses valid cursor', () => {
    const c = CursorSchema.parse({ value: 'abc123' });
    expect(c.value).toBe('abc123');
  });

  it('rejects empty cursor value', () => {
    expect(() => CursorSchema.parse({ value: '' })).toThrow();
  });
});

describe('paginatedSchema', () => {
  const itemSchema = z.object({ id: z.string() });
  const schema = paginatedSchema(itemSchema);

  it('parses page with items and total', () => {
    const page = schema.parse({ items: [{ id: '1' }], total: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.nextCursor).toBeUndefined();
  });

  it('parses page with nextCursor', () => {
    const page = schema.parse({
      items: [],
      total: 100,
      nextCursor: { value: 'cursor-xyz' },
    });
    expect(page.nextCursor?.value).toBe('cursor-xyz');
  });

  it('rejects negative total', () => {
    expect(() => schema.parse({ items: [], total: -1 })).toThrow();
  });

  it('handles empty items array', () => {
    const page = schema.parse({ items: [], total: 0 });
    expect(page.items).toHaveLength(0);
  });
});

describe('FilterSchema', () => {
  it('parses empty filter', () => {
    const f = FilterSchema.parse({});
    expect(f.limit).toBeUndefined();
    expect(f.cursor).toBeUndefined();
  });

  it('parses limit and sortDirection', () => {
    const f = FilterSchema.parse({ limit: 20, sortDirection: 'desc' });
    expect(f.limit).toBe(20);
    expect(f.sortDirection).toBe('desc');
  });

  it('parses structured conditions and field sorting', () => {
    const f = FilterSchema.parse({
      conditions: [{ field: 'status', op: 'eq', value: 'active' }],
      sort: [{ field: 'createdAt', direction: 'desc' }],
    });
    expect(f.conditions?.[0]?.field).toBe('status');
    expect(f.conditions?.[0]?.op).toBe('eq');
    expect(f.sort?.[0]?.field).toBe('createdAt');
  });

  it('rejects limit of zero', () => {
    expect(() => FilterSchema.parse({ limit: 0 })).toThrow();
  });

  it('rejects limit over 1000', () => {
    expect(() => FilterSchema.parse({ limit: 1001 })).toThrow();
  });
});

describe('PagingSchema', () => {
  it('parses cursor paging', () => {
    const paging = PagingSchema.parse({ limit: 50, cursor: 'next' });
    expect(paging.limit).toBe(50);
    expect(paging.cursor).toBe('next');
  });

  it('rejects negative limits', () => {
    expect(() => PagingSchema.parse({ limit: -1 })).toThrow();
  });
});

describe('SortSchema', () => {
  it('parses a field sort', () => {
    const sort = SortSchema.parse({ field: 'createdAt', direction: 'asc' });
    expect(sort.field).toBe('createdAt');
  });

  it('rejects empty sort field', () => {
    expect(() => SortSchema.parse({ field: '', direction: 'asc' })).toThrow();
  });
});

describe('FilterConditionSchema', () => {
  it('parses a filter condition', () => {
    const condition = FilterConditionSchema.parse({ field: 'age', op: 'gte', value: 18 });
    expect(condition.op).toBe('gte');
  });

  it('rejects unknown operators', () => {
    expect(() => FilterConditionSchema.parse({ field: 'age', op: 'sql', value: 18 })).toThrow();
  });
});

describe('FilterOperatorSchema', () => {
  it('accepts supported operators', () => {
    expect(FilterOperatorSchema.parse('eq')).toBe('eq');
    expect(FilterOperatorSchema.parse('contains')).toBe('contains');
  });
});

describe('SortDirectionSchema', () => {
  it('accepts asc and desc', () => {
    expect(SortDirectionSchema.parse('asc')).toBe('asc');
    expect(SortDirectionSchema.parse('desc')).toBe('desc');
  });

  it('rejects invalid direction', () => {
    expect(() => SortDirectionSchema.parse('DESC')).toThrow();
  });
});
