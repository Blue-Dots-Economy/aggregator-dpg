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
  OUTCOME_METRICS: [],
};

describe('GET /ready', () => {
  it('returns 200 when redis pings', async () => {
    const app = await buildServer({
      config: cfg,
      redis: new RedisMock() as never,
      meter: metrics.getMeter('t'),
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
    await app.close();
  });

  it('returns 503 when redis is down', async () => {
    const broken = {
      ping: async () => {
        throw new Error('down');
      },
    } as never;
    const app = await buildServer({ config: cfg, redis: broken, meter: metrics.getMeter('t') });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
