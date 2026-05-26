import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyHmac } from '../hmac-auth.js';

const secrets = { 'svc-api': 'shh' };

describe('verifyHmac', () => {
  const body = '{"event":"x"}';
  const ts = '1700000000000';
  const sig = createHmac('sha256', 'shh')
    .update(ts + body)
    .digest('hex');

  it('accepts a valid signature within the replay window', () => {
    const now = Number(ts) + 60_000; // 60s later
    expect(
      verifyHmac({ keyId: 'svc-api', signature: sig, timestamp: ts, body, secrets, now }),
    ).toBe('ok');
  });

  it('rejects unknown keyId', () => {
    expect(
      verifyHmac({
        keyId: 'svc-other',
        signature: sig,
        timestamp: ts,
        body,
        secrets,
        now: Number(ts),
      }),
    ).toBe('unknown_key');
  });

  it('rejects bad signature', () => {
    expect(
      verifyHmac({
        keyId: 'svc-api',
        signature: 'deadbeef',
        timestamp: ts,
        body,
        secrets,
        now: Number(ts),
      }),
    ).toBe('bad_sig');
  });

  it('rejects stale timestamp (>5m)', () => {
    expect(
      verifyHmac({
        keyId: 'svc-api',
        signature: sig,
        timestamp: ts,
        body,
        secrets,
        now: Number(ts) + 6 * 60_000,
      }),
    ).toBe('stale');
  });

  it('rejects missing keyId / signature / timestamp', () => {
    expect(
      verifyHmac({
        keyId: undefined,
        signature: sig,
        timestamp: ts,
        body,
        secrets,
        now: Number(ts),
      }),
    ).toBe('missing');
    expect(
      verifyHmac({
        keyId: 'svc-api',
        signature: undefined,
        timestamp: ts,
        body,
        secrets,
        now: Number(ts),
      }),
    ).toBe('missing');
    expect(
      verifyHmac({
        keyId: 'svc-api',
        signature: sig,
        timestamp: undefined,
        body,
        secrets,
        now: Number(ts),
      }),
    ).toBe('missing');
  });
});
