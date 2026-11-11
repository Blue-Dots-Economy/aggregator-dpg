import { afterEach, describe, expect, it, vi } from 'vitest';
import { BulkUploadTooLargeError, onboardingService } from '../onboarding.service';

const created = (extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      upload_id: 'u1',
      upload_url: 'https://legacy.example/put',
      s3_key: 'k',
      expires_at: '2026-01-01',
      content_type: 'text/csv',
      max_bytes: 1000,
      schema_id: 's',
      schema_version: '1',
      status: 'pending',
      ...extra,
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );

const started = () =>
  new Response(
    JSON.stringify({
      upload_id: 'u1',
      status: 'queued',
      status_reason: null,
      participant_type: 'seeker',
      errors_csv_s3_key: null,
      total_rows: null,
      passed: 0,
      failed: 0,
      skipped: 0,
      schema_id: 's',
      schema_version: '1',
      created_at: '2026-01-01',
      completed_at: null,
    }),
    { status: 202, headers: { 'content-type': 'application/json' } },
  );

const file = new File(['a,b'], 'rows.csv', { type: 'text/csv' });

afterEach(() => vi.restoreAllMocks());

describe('bulk upload follows the upload instructions', () => {
  it('sends PUT instructions with the file and the given headers', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        created({
          upload: {
            method: 'PUT',
            url: 'https://store.example/put',
            headers: { 'Content-Type': 'text/csv' },
            form_fields: {},
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(started());
    await onboardingService.uploadCsv(file, 'seeker', true);
    const [url, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://store.example/put');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(file);
    expect(init.headers).toEqual({ 'Content-Type': 'text/csv' });
  });

  it('sends POST instructions as form data with the file last', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        created({
          upload: {
            method: 'POST',
            url: 'https://store.example/post',
            headers: {},
            form_fields: { key: 'k', policy: 'p' },
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(started());
    await onboardingService.uploadCsv(file, 'seeker', true);
    const [url, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://store.example/post');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({});
    const body = init.body as FormData;
    expect([...body.keys()]).toEqual(['key', 'policy', 'file']);
    expect(body.get('key')).toBe('k');
  });

  it('falls back to upload_url and content_type without instructions', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(created())
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(started());
    await onboardingService.uploadCsv(file, 'seeker', true);
    const [url, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://legacy.example/put');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'Content-Type': 'text/csv' });
  });

  it('reports the status only when storage rejects the file', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(created())
      .mockResolvedValueOnce(new Response('secret body', { status: 403 }));
    await expect(onboardingService.uploadCsv(file, 'seeker', true)).rejects.toThrow(
      /^File upload failed \(403\)$/,
    );
  });

  it('rejects a file over max_bytes before any upload request', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(created({ max_bytes: 10 }));
    const big = new File(['x'.repeat(11)], 'big.csv', { type: 'text/csv' });
    const err = await onboardingService.uploadCsv(big, 'seeker', true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BulkUploadTooLargeError);
    expect((err as BulkUploadTooLargeError).maxBytes).toBe(10);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('uploads a file of exactly max_bytes', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(created({ max_bytes: 10 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(started());
    const exact = new File(['x'.repeat(10)], 'exact.csv', { type: 'text/csv' });
    await onboardingService.uploadCsv(exact, 'seeker', true);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
