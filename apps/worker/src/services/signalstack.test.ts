/**
 * Unit tests for the worker process's SignalStack writer factory.
 *
 * `getSignalStackWriter()` memoises its result in a module-level `writer`
 * variable, and `config` is parsed once eagerly at module load — so every
 * test resets the module registry and re-imports both fresh, after setting
 * the env vars that case needs. That's the only way to exercise more than
 * one config combination in a single test file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const BASE_ENV = {
  SIGNALSTACK_BASE_URL: 'http://signalstack.test',
};

async function freshFactory() {
  vi.resetModules();
  const factoryModule = await import('./signalstack.js');
  return { getSignalStackWriter: factoryModule.getSignalStackWriter };
}

describe('getSignalStackWriter (worker)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv, ...BASE_ENV };
    delete process.env.SIGNALSTACK_ADMIN_KEY;
    delete process.env.SIGNALSTACK_AUTH_MODE;
    delete process.env.SIGNALSTACK_CLIENT_ID;
    delete process.env.SIGNALSTACK_CLIENT_SECRET;
    delete process.env.KEYCLOAK_URL;
    delete process.env.KEYCLOAK_REALM;
  });

  it('returns null when SIGNALSTACK_BASE_URL is unset', async () => {
    delete process.env.SIGNALSTACK_BASE_URL;
    const { getSignalStackWriter } = await freshFactory();
    expect(getSignalStackWriter()).toBeNull();
  });

  describe('apikey mode (default)', () => {
    it('returns null when SIGNALSTACK_ADMIN_KEY is missing', async () => {
      const { getSignalStackWriter } = await freshFactory();
      expect(getSignalStackWriter()).toBeNull();
    });

    it('builds a writer when SIGNALSTACK_ADMIN_KEY is set', async () => {
      process.env.SIGNALSTACK_ADMIN_KEY = 'admin-key';
      const { getSignalStackWriter } = await freshFactory();
      expect(getSignalStackWriter()).not.toBeNull();
    });
  });

  describe('bearer mode', () => {
    beforeEach(() => {
      process.env.SIGNALSTACK_AUTH_MODE = 'bearer';
      process.env.SIGNALSTACK_CLIENT_ID = 'aggregator-dpg';
      process.env.SIGNALSTACK_CLIENT_SECRET = 'shh';
      process.env.KEYCLOAK_URL = 'http://keycloak.test';
      process.env.KEYCLOAK_REALM = 'bluedots';
    });

    it('builds a writer when client id/secret + Keycloak URL/realm are all set', async () => {
      const { getSignalStackWriter } = await freshFactory();
      expect(getSignalStackWriter()).not.toBeNull();
    });

    it.each([
      'SIGNALSTACK_CLIENT_ID',
      'SIGNALSTACK_CLIENT_SECRET',
      'KEYCLOAK_URL',
      'KEYCLOAK_REALM',
    ])('returns null when %s is missing', async (missing) => {
      delete process.env[missing];
      const { getSignalStackWriter } = await freshFactory();
      expect(getSignalStackWriter()).toBeNull();
    });
  });
});
