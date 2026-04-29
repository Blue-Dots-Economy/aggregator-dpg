import { describe, it, expect } from 'vitest';
import { IdentityProviderFake, buildTokenSet, buildIdClaims } from '@/lib/oidc/testing';

describe('IdentityProviderFake', () => {
  it('builds an authorization URL with state, nonce, PKCE', async () => {
    const fake = new IdentityProviderFake();
    const url = await fake.buildAuthorizationUrl({
      state: 'st',
      nonce: 'no',
      codeChallenge: 'cc',
      redirectUri: 'http://app/cb',
    });
    const u = new URL(url);
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('nonce')).toBe('no');
    expect(u.searchParams.get('code_challenge')).toBe('cc');
    expect(u.searchParams.get('redirect_uri')).toBe('http://app/cb');
  });

  it('rejects exchange when state mismatches', async () => {
    const fake = new IdentityProviderFake();
    const r = await fake.exchangeCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://app/cb',
      state: 'a',
      expectedState: 'b',
      expectedNonce: 'n',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('STATE_MISMATCH');
  });

  it('returns seeded tokens on successful exchange', async () => {
    const fake = new IdentityProviderFake();
    fake.seedExchange({
      code: 'auth-code',
      tokens: buildTokenSet({ accessToken: 'AT' }),
      claims: buildIdClaims({ sub: 'sub-1' }),
    });
    const r = await fake.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'v',
      redirectUri: 'http://app/cb',
      state: 's',
      expectedState: 's',
      expectedNonce: 'n',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tokens.accessToken).toBe('AT');
      expect(r.value.claims.sub).toBe('sub-1');
    }
  });

  it('fails exchange when forced', async () => {
    const fake = new IdentityProviderFake();
    fake.failExchangeOnce({ code: 'X', message: 'boom' });
    const r = await fake.exchangeCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://app/cb',
      state: 's',
      expectedState: 's',
      expectedNonce: 'n',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TOKEN_EXCHANGE_FAILED');
  });

  it('returns seeded refresh response', async () => {
    const fake = new IdentityProviderFake();
    fake.seedRefresh('rt', { ok: true, value: buildTokenSet({ accessToken: 'NEW' }) });
    const r = await fake.refresh('rt');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.accessToken).toBe('NEW');
  });

  it('refresh fails with no seed', async () => {
    const fake = new IdentityProviderFake();
    const r = await fake.refresh('rt');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('REFRESH_FAILED');
  });

  it('builds RP-initiated logout URL', async () => {
    const fake = new IdentityProviderFake();
    const url = await fake.buildLogoutUrl({
      idToken: 'idt',
      postLogoutRedirectUri: 'http://app/',
    });
    const u = new URL(url);
    expect(u.searchParams.get('id_token_hint')).toBe('idt');
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe('http://app/');
  });
});
