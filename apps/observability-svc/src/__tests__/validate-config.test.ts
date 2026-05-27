import { describe, expect, it } from 'vitest';
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
  OUTCOME_METRICS: [{ name: 'x.total', instrument: 'counter' }],
};

describe('GET /validate-config', () => {
  it('returns 401 without bearer token', async () => {
    const app = await buildServer({
      config: cfg,
      redis: new RedisMock() as never,
      meter: metrics.getMeter('t'),
    });
    const res = await app.inject({ method: 'GET', url: '/validate-config' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 401 with wrong token', async () => {
    const app = await buildServer({
      config: cfg,
      redis: new RedisMock() as never,
      meter: metrics.getMeter('t'),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/validate-config',
      headers: { authorization: 'Bearer wrong-token-of-correct-length-22' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 200 with loaded config when token is correct', async () => {
    const app = await buildServer({
      config: cfg,
      redis: new RedisMock() as never,
      meter: metrics.getMeter('t'),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/validate-config',
      headers: { authorization: `Bearer ${cfg.ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome_metrics).toHaveLength(1);
    expect(res.json().idem_ttl_days).toBe(90);
    await app.close();
  });
});
