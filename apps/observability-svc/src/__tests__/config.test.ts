import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

describe('observability-svc config', () => {
  it('parses minimal env', () => {
    const cfg = loadConfig({
      PORT: '8080',
      REDIS_URL: 'redis://localhost:6379',
      OUTCOMES_HMAC_SECRETS_JSON: '{"svc-api":"shh"}',
      ADMIN_TOKEN: 'admin-secret-very-long',
      APP_VERSION: '1.0.0',
    });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.OUTCOMES_HMAC_SECRETS['svc-api']).toBe('shh');
  });
});
