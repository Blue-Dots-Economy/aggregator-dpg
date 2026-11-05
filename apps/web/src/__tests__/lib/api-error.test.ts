import { describe, it, expect } from 'vitest';
import { readApiError } from '@/lib/api-error';

function response(body: string, status = 400): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

describe('readApiError', () => {
  it('reads the code, detail and message of an API error body', async () => {
    const res = response(
      JSON.stringify({
        error: { code: 'RATE_LIMITED', detail: 'Retry in 5s.', message: 'Slow down', extra: 1 },
      }),
    );
    await expect(readApiError(res)).resolves.toEqual({
      code: 'RATE_LIMITED',
      detail: 'Retry in 5s.',
      message: 'Slow down',
    });
  });

  it('answers null for a body that is not JSON', async () => {
    await expect(readApiError(response('<html>', 502))).resolves.toBeNull();
  });

  it('answers null for JSON without an error object', async () => {
    await expect(readApiError(response(JSON.stringify({ ok: false })))).resolves.toBeNull();
  });

  it('keeps the readable fields when another field has the wrong type', async () => {
    const res = response(JSON.stringify({ error: { code: 42, detail: 'Bad input.' } }));
    await expect(readApiError(res)).resolves.toEqual({ detail: 'Bad input.' });
  });
});
