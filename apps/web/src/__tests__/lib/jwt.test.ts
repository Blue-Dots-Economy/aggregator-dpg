import { describe, it, expect } from 'vitest';
import { classifyNonCoordinator, decodeJwtClaims, tokenUserId, tokenRealmRoles } from '@/lib/jwt';

function makeToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('decodeJwtClaims', () => {
  it('decodes a well-formed token payload', () => {
    const token = makeToken({ sub: 'user-1', user_id: 'agg-1' });
    expect(decodeJwtClaims(token)).toEqual({ sub: 'user-1', user_id: 'agg-1' });
  });

  it('returns null when the token has fewer than 2 parts', () => {
    expect(decodeJwtClaims('onlyonepart')).toBeNull();
  });

  it('returns null when the payload is not valid base64url JSON', () => {
    expect(decodeJwtClaims('header.!!!notbase64orjson!!!.sig')).toBeNull();
  });
});

describe('decodeJwtClaims with a payload that is not an object', () => {
  function tokenWith(payload: unknown): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    return `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
  }

  it.each([
    ['an array', ['user_id']],
    ['a string', 'agg-1'],
    ['null', null],
  ])('returns null for %s', (_label, payload) => {
    expect(decodeJwtClaims(tokenWith(payload))).toBeNull();
  });
});

describe('tokenUserId', () => {
  it('returns the user_id claim when present and non-empty', () => {
    expect(tokenUserId(makeToken({ user_id: 'agg-42' }))).toBe('agg-42');
  });

  it('returns null when user_id is absent', () => {
    expect(tokenUserId(makeToken({ sub: 'user-1' }))).toBeNull();
  });

  it('returns null when user_id is an empty string', () => {
    expect(tokenUserId(makeToken({ user_id: '' }))).toBeNull();
  });

  it('returns null when user_id is not a string', () => {
    expect(tokenUserId(makeToken({ user_id: 123 }))).toBeNull();
  });

  it('returns null for a malformed token', () => {
    expect(tokenUserId('garbage')).toBeNull();
  });

  it('returns null for a token that carries only aggregator_id', () => {
    expect(tokenUserId(makeToken({ aggregator_id: 'agg-42' }))).toBeNull();
  });

  it('reads user_id and ignores aggregator_id', () => {
    expect(tokenUserId(makeToken({ user_id: 'agg-42', aggregator_id: 'agg-7' }))).toBe('agg-42');
  });
});

describe('tokenRealmRoles', () => {
  it('reads realm_access.roles', () => {
    const token = makeToken({ realm_access: { roles: ['seeker', 'offline_access'] } });
    expect(tokenRealmRoles(token)).toEqual(['seeker', 'offline_access']);
  });

  it('returns [] when realm_access is absent, null, or malformed', () => {
    expect(tokenRealmRoles(makeToken({}))).toEqual([]);
    expect(tokenRealmRoles(makeToken({ realm_access: null }))).toEqual([]);
    expect(tokenRealmRoles(makeToken({ realm_access: { roles: 'nope' } }))).toEqual([]);
  });

  it('drops non-string entries rather than trusting the claim shape', () => {
    const token = makeToken({ realm_access: { roles: ['ok', 42, null] } });
    expect(tokenRealmRoles(token)).toEqual(['ok']);
  });
});

describe('classifyNonCoordinator', () => {
  const SIGNALS = ['seeker', 'provider'];

  it('identifies a Signals participant by its realm role', () => {
    const token = makeToken({ realm_access: { roles: ['seeker'] } });
    expect(classifyNonCoordinator(token, SIGNALS)).toBe('signals_participant');
  });

  it('identifies an org owner', () => {
    const token = makeToken({ realm_access: { roles: ['org_owner'] } });
    expect(classifyNonCoordinator(token, SIGNALS)).toBe('org_owner');
  });

  it('prefers the Signals verdict when a token somehow carries both', () => {
    // Cross-app confusion is the thing being explained, so naming the other
    // app is more useful than the org-owner copy about emailed approval links.
    const token = makeToken({ realm_access: { roles: ['org_owner', 'seeker'] } });
    expect(classifyNonCoordinator(token, SIGNALS)).toBe('signals_participant');
  });

  it('falls back to unknown for any other realm user', () => {
    const token = makeToken({ realm_access: { roles: ['offline_access'] } });
    expect(classifyNonCoordinator(token, SIGNALS)).toBe('unknown');
  });

  it('falls back to unknown when the Signals roles are unconfigured', () => {
    // A wrong message is worse than a generic one, so an empty config must
    // never let a Signals user be described as something else.
    const token = makeToken({ realm_access: { roles: ['seeker'] } });
    expect(classifyNonCoordinator(token, [])).toBe('unknown');
  });
});
