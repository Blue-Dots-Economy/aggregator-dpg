import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { invalidQueryResponse, isPostgresUuid, parseQuery } from '@/lib/bff-input';

describe('isPostgresUuid', () => {
  it('accepts the canonical form in either case', () => {
    expect(isPostgresUuid('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(true);
    expect(isPostgresUuid('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11')).toBe(true);
  });

  it('accepts the other text forms Postgres reads', () => {
    expect(isPostgresUuid('{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}')).toBe(true);
    expect(isPostgresUuid('a0eebc999c0b4ef8bb6d6bb9bd380a11')).toBe(true);
    expect(isPostgresUuid('a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11')).toBe(true);
    expect(isPostgresUuid('{a0eebc99-9c0b4ef8-bb6d6bb9-bd380a11}')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isPostgresUuid('')).toBe(false);
    expect(isPostgresUuid('l1')).toBe(false);
    expect(isPostgresUuid('not-a-uuid')).toBe(false);
    expect(isPostgresUuid('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1')).toBe(false);
    expect(isPostgresUuid('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11a')).toBe(false);
    expect(isPostgresUuid('g0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(false);
    expect(isPostgresUuid('a0eebc99--9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(false);
    expect(isPostgresUuid('-a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(false);
    expect(isPostgresUuid('{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(false);
    expect(isPostgresUuid('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}')).toBe(false);
    expect(isPostgresUuid(' a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(false);
    expect(isPostgresUuid('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/../x')).toBe(false);
  });
});

describe('parseQuery', () => {
  const Schema = z.object({
    status: z.enum(['draft', 'live']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });

  it('returns an empty search when no known key is present', () => {
    expect(parseQuery(new URLSearchParams(''), Schema)).toEqual({ ok: true, search: '' });
  });

  it('forwards only the schema keys, with their original text', () => {
    const result = parseQuery(new URLSearchParams('limit=010&status=live&debug=1'), Schema);
    expect(result).toEqual({ ok: true, search: '?status=live&limit=010' });
  });

  it('re-encodes values for the rebuilt query string', () => {
    const Free = z.object({ q: z.string().optional() });
    const result = parseQuery(new URLSearchParams('q=a%26b%3Dc'), Free);
    expect(result).toEqual({ ok: true, search: '?q=a%26b%3Dc' });
  });

  it('uses the first value of a repeated key', () => {
    const result = parseQuery(new URLSearchParams('limit=5&limit=500'), Schema);
    expect(result).toEqual({ ok: true, search: '?limit=5' });
  });

  it('rejects a value the schema does not accept', async () => {
    const result = parseQuery(new URLSearchParams('limit=0'), Schema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    await expect(result.response.json()).resolves.toEqual({
      error: { code: 'SCHEMA_VALIDATION', title: 'Invalid query parameters' },
    });
  });

  it('applies a refinement on a wrapped object schema', () => {
    const Either = z
      .object({ email: z.string().optional(), phone: z.string().optional() })
      .refine((v) => Boolean(v.email) || Boolean(v.phone));
    expect(parseQuery(new URLSearchParams('phone=1&x=2'), Either)).toEqual({
      ok: true,
      search: '?phone=1',
    });
    expect(parseQuery(new URLSearchParams('x=2'), Either).ok).toBe(false);
  });
});

describe('invalidQueryResponse', () => {
  it('is a 400 SCHEMA_VALIDATION envelope without the received values', async () => {
    const res = invalidQueryResponse();
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: 'SCHEMA_VALIDATION', title: 'Invalid query parameters' },
    });
  });
});
