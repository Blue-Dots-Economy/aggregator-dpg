import { describe, expect, it, vi } from 'vitest';
import { emitTurn, emitSignal, configureOutcomes } from '../outcomes.js';

describe('outcomes client', () => {
  it('is a no-op when outcomes_svc_url is unset', async () => {
    const fetchSpy = vi.fn();
    configureOutcomes({ fetchImpl: fetchSpy });
    await emitTurn({ event: 'participant.created', idempotency_key: 'k1', attributes: {} });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts HMAC-signed payload when configured', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    configureOutcomes({
      outcomesSvcUrl: 'http://observability-svc:8080',
      hmacKeyId: 'svc-api',
      hmacSecret: 'shh',
      fetchImpl: fetchSpy,
    });
    await emitTurn({ event: 'participant.created', idempotency_key: 'k1', attributes: {} });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://observability-svc:8080/emit/turn');
    expect(init.headers['X-Outcome-Key-Id']).toBe('svc-api');
    expect(typeof init.headers['X-Outcome-Signature']).toBe('string');
    expect(typeof init.headers['X-Outcome-Timestamp']).toBe('string');
  });

  it('never throws on network failure', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('down'));
    configureOutcomes({
      outcomesSvcUrl: 'http://observability-svc:8080',
      hmacKeyId: 'svc-api',
      hmacSecret: 'shh',
      fetchImpl: fetchSpy,
    });
    await expect(
      emitSignal({ name: 'drop', idempotency_key: 'k', attributes: {} }),
    ).resolves.toBeUndefined();
  });
});
