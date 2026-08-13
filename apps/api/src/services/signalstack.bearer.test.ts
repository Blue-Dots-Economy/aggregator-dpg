/**
 * Bearer-mode (Keycloak client-credentials) coverage for the api process's
 * SignalStack writer factory.
 *
 * The apikey path, acting-org warning, and singleton caching live in
 * `signalstack.test.ts` (which mocks `../config.js`). Bearer mode parses real
 * config *and* `process.env.KEYCLOAK_URL/REALM`, so this file uses the
 * reset-modules / real-import harness instead — `config` is parsed once eagerly
 * at module load, so every test resets the registry and re-imports fresh after
 * setting the env vars that case needs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const BASE_ENV = {
  SIGNALSTACK_BASE_URL: 'http://signalstack.test',
  SIGNALSTACK_ACTING_ORG_ID: 'org-platform',
};

async function freshFactory() {
  vi.resetModules();
  await import('../config.js');
  const factoryModule = await import('./signalstack.js');
  return { getSignalStackWriter: factoryModule.getSignalStackWriter };
}

describe('getSignalStackWriter — bearer mode', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv, ...BASE_ENV };
    delete process.env.SIGNALSTACK_ADMIN_KEY;
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

  it('does not require SIGNALSTACK_ADMIN_KEY', async () => {
    delete process.env.SIGNALSTACK_ADMIN_KEY;
    const { getSignalStackWriter } = await freshFactory();
    expect(getSignalStackWriter()).not.toBeNull();
  });

  it.each(['SIGNALSTACK_CLIENT_ID', 'SIGNALSTACK_CLIENT_SECRET', 'KEYCLOAK_URL', 'KEYCLOAK_REALM'])(
    'returns null when %s is missing',
    async (missing) => {
      delete process.env[missing];
      const { getSignalStackWriter } = await freshFactory();
      expect(getSignalStackWriter()).toBeNull();
    },
  );
});
