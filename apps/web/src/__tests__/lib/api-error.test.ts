import { describe, it, expect } from 'vitest';
import { apiErrorMessage, readApiError, readErrorEnvelope } from '@/lib/api-error';

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

  it('reads the BFF error shape, where error is a label and code and message sit beside it', async () => {
    const res = response(
      JSON.stringify({
        error: 'Unauthorized',
        code: 'NO_ACTIVE_SESSION',
        message: 'Sign in again.',
      }),
      401,
    );
    await expect(readApiError(res)).resolves.toEqual({
      code: 'NO_ACTIVE_SESSION',
      message: 'Sign in again.',
    });
  });
});

describe('apiErrorMessage', () => {
  it('prefers the detail, then the message', async () => {
    await expect(
      apiErrorMessage(
        response(JSON.stringify({ error: { detail: 'd', message: 'm' } })),
        'fallback',
      ),
    ).resolves.toBe('d');
    await expect(
      apiErrorMessage(response(JSON.stringify({ error: { detail: 7, message: 'm' } })), 'fallback'),
    ).resolves.toBe('m');
  });

  it('uses the BFF message', async () => {
    const res = response(
      JSON.stringify({ error: 'ServiceUnavailable', message: 'Try later.' }),
      503,
    );
    await expect(apiErrorMessage(res, 'fallback')).resolves.toBe('Try later.');
  });

  it('falls back when the body has no readable text', async () => {
    await expect(apiErrorMessage(response('<html>', 502), 'export failed: 502')).resolves.toBe(
      'export failed: 502',
    );
  });
});

describe('readErrorEnvelope', () => {
  it('reads the string fields and the fields object', () => {
    expect(
      readErrorEnvelope({
        error: { code: 'X', title: 'T', detail: 'D', requestId: 'r', fields: { a: 'b' } },
      }),
    ).toEqual({ code: 'X', title: 'T', detail: 'D', requestId: 'r', fields: { a: 'b' } });
  });

  it('drops a field of the wrong type and keeps the rest', () => {
    expect(readErrorEnvelope({ error: { code: 7, title: 'T', fields: [] } })).toEqual({
      title: 'T',
    });
  });

  it('returns an empty object when there is no error object', () => {
    expect(readErrorEnvelope(null)).toEqual({});
    expect(readErrorEnvelope({ error: 'Bad Request' })).toEqual({});
  });
});
