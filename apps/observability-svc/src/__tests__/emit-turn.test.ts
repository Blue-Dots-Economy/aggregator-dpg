import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import RedisMock from 'ioredis-mock';
import { metrics } from '@opentelemetry/api';
import { buildServer } from '../server.js';
import type { AppConfig } from '../config.js';

const cfg: AppConfig = {
  NODE_ENV: 'test',
  PORT: 0,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  REDIS_URL: '',
  OUTCOMES_HMAC_SECRETS: { 'svc-api': 'shh' },
  ADMIN_TOKEN: 'adm-token-very-long-string',
  APP_VERSION: 'test',
  IDEM_TTL_DAYS: 90,
  OTEL_SDK_DISABLED: true,
  OTEL_COLLECTOR_ENDPOINT: '',
  OTEL_SAMPLE_RATE: 1,
  OUTCOME_METRICS: [],
};

function sign(body: string, ts: string): string {
  return createHmac('sha256', 'shh')
    .update(ts + body)
    .digest('hex');
}

describe('POST /emit/turn', () => {
  it('returns 401 without HMAC headers', async () => {
    const app = await buildServer({
      config: cfg,
      redis: new RedisMock() as never,
      meter: metrics.getMeter('t'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/emit/turn',
      payload: { event: 'x', idempotency_key: 'k', attributes: {} },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 200 on first valid emit and 200 (duplicate) on the second', async () => {
    const app = await buildServer({
      config: cfg,
      redis: new RedisMock() as never,
      meter: metrics.getMeter('t'),
    });
    const body = JSON.stringify({
      event: 'participant.created',
      idempotency_key: 'k-1',
      attributes: {},
    });
    const ts = String(Date.now());
    const headers = {
      'content-type': 'application/json',
      'x-outcome-key-id': 'svc-api',
      'x-outcome-signature': sign(body, ts),
      'x-outcome-timestamp': ts,
    };
    const a = await app.inject({ method: 'POST', url: '/emit/turn', headers, payload: body });
    const b = await app.inject({ method: 'POST', url: '/emit/turn', headers, payload: body });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    await app.close();
  });
});
