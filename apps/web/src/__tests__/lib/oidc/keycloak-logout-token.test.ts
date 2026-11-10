import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

/**
 * `KeycloakAdapter.verifyLogoutToken` against real signatures: a key set is
 * served on a loopback port and tokens are signed with jose, so signature,
 * issuer and audience checks run for real. Only discovery is faked, to point
 * the adapter at that key set.
 */

const discovered = vi.hoisted(() => ({ issuer: '', jwks_uri: '' }));

vi.mock('openid-client', () => {
  class MockClient {
    issuer = { metadata: discovered };
    [key: symbol]: unknown;
  }
  const Issuer = vi.fn() as unknown as Record<string, unknown> & Record<symbol, unknown>;
  Issuer.discover = vi.fn(async () => ({ Client: MockClient }));
  return {
    Issuer,
    generators: {},
    custom: { http_options: Symbol('http_options') },
  };
});

const { KeycloakAdapter } = await import('@/lib/oidc/keycloak');

const KID = 'test-key';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
let privateKey: CryptoKey;
let foreignKey: CryptoKey;
let server: Server;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  foreignKey = (await generateKeyPair('RS256')).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  discovered.issuer = `http://127.0.0.1:${port}/realms/bluedots`;
  discovered.jwks_uri = `${discovered.issuer}/protocol/openid-connect/certs`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function adapter() {
  return new KeycloakAdapter({ issuerUrl: discovered.issuer, clientId: 'aggregator-portal' });
}

/** A logout token shaped the way Keycloak sends one. */
async function logoutToken(
  over: { aud?: string; claims?: Record<string, unknown>; omit?: string[]; key?: CryptoKey } = {},
): Promise<string> {
  const payload: Record<string, unknown> = {
    sid: 'kc-session-1',
    events: { [LOGOUT_EVENT]: {} },
    jti: 'jti-1',
    ...over.claims,
  };
  for (const name of over.omit ?? []) delete payload[name];
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(discovered.issuer)
    .setAudience(over.aud ?? 'aggregator-portal')
    .setSubject('user-1')
    .setIssuedAt()
    .sign(over.key ?? privateKey);
}

describe('KeycloakAdapter.verifyLogoutToken', () => {
  it('accepts a logout token for this client and returns its session id', async () => {
    const result = await adapter().verifyLogoutToken(await logoutToken());
    expect(result).toEqual({ ok: true, value: { sid: 'kc-session-1' } });
  });

  it('rejects a token addressed to another client in the shared realm', async () => {
    const result = await adapter().verifyLogoutToken(await logoutToken({ aud: 'signals-ui' }));
    expect(result).toMatchObject({ ok: false, error: { code: 'LOGOUT_TOKEN_INVALID' } });
  });

  it('rejects a token signed by a key the realm does not publish', async () => {
    const result = await adapter().verifyLogoutToken(await logoutToken({ key: foreignKey }));
    expect(result).toMatchObject({ ok: false, error: { code: 'LOGOUT_TOKEN_INVALID' } });
  });

  it('rejects an unsigned token', async () => {
    const [, body] = (await logoutToken()).split('.');
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${body}.`;
    const result = await adapter().verifyLogoutToken(unsigned);
    expect(result).toMatchObject({ ok: false, error: { code: 'LOGOUT_TOKEN_INVALID' } });
  });

  it('rejects a signed token that is not a logout event, carries a nonce, or has no sid', async () => {
    const a = adapter();
    for (const token of [
      await logoutToken({ omit: ['events'] }),
      await logoutToken({ claims: { nonce: 'n' } }),
      await logoutToken({ omit: ['sid'] }),
      await logoutToken({ omit: ['jti'] }),
    ]) {
      expect(await a.verifyLogoutToken(token)).toMatchObject({
        ok: false,
        error: { code: 'LOGOUT_TOKEN_INVALID' },
      });
    }
  });

  it('reports unreachable keys as unavailable, not as a bad token', async () => {
    const saved = discovered.jwks_uri;
    discovered.jwks_uri = 'http://127.0.0.1:1/unreachable';
    try {
      const result = await adapter().verifyLogoutToken(await logoutToken());
      expect(result).toMatchObject({ ok: false, error: { code: 'KEYS_UNAVAILABLE' } });
    } finally {
      discovered.jwks_uri = saved;
    }
  });
});
