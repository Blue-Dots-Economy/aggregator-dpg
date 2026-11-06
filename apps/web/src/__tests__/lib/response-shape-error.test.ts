import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseResponseBody, ResponseShapeError } from '@/lib/response-shape-error';

const Schema = z.object({ id: z.string() });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('parseResponseBody', () => {
  it('returns the schema output', async () => {
    await expect(parseResponseBody(json({ id: 'a', extra: 1 }), '/x', Schema)).resolves.toEqual({
      id: 'a',
    });
  });

  it('throws ResponseShapeError with the issues when the body does not match', async () => {
    const error: unknown = await parseResponseBody(json({ id: 7 }), '/x', Schema).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ResponseShapeError);
    expect(error instanceof ResponseShapeError && error.issueSummary()).toEqual([
      { path: 'id', code: 'invalid_type' },
    ]);
  });

  it('treats a JSON null body as a mismatch, not as text that is not JSON', async () => {
    const error: unknown = await parseResponseBody(json(null), '/x', Schema).catch(
      (e: unknown) => e,
    );
    expect(error instanceof ResponseShapeError && error.issueSummary()).toEqual([
      { path: '', code: 'invalid_type' },
    ]);
  });

  it('throws ResponseShapeError with no issues when the body is not JSON', async () => {
    const error: unknown = await parseResponseBody(
      new Response('<html>', { status: 200 }),
      '/x',
      Schema,
    ).catch((e: unknown) => e);
    expect(error instanceof ResponseShapeError && error.issues).toEqual([]);
  });
});

describe('ResponseShapeError', () => {
  it('keeps the issues out of its enumerable properties, so printing it shows no values', () => {
    const parsed = Schema.safeParse({ id: 12345 });
    const error = new ResponseShapeError('/x', parsed.success ? [] : parsed.error.issues);
    expect(error.issues).toHaveLength(1);
    expect(Object.keys(error)).not.toContain('issues');
    expect(JSON.stringify({ ...error })).not.toContain('12345');
  });
});
