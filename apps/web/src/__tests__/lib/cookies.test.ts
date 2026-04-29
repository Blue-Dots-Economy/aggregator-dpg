import { describe, it, expect, beforeEach } from 'vitest';
import { signFlowState, verifyFlowState } from '@/lib/cookies';

describe('flow state signing', () => {
  beforeEach(() => {
    process.env.SESSION_KEY = 'a'.repeat(48);
  });

  it('round-trips a valid state', () => {
    const original = {
      state: 'st',
      nonce: 'no',
      codeVerifier: 'verifier',
      returnTo: '/dashboard',
    };
    const signed = signFlowState(original);
    expect(verifyFlowState(signed)).toEqual(original);
  });

  it('rejects undefined input', () => {
    expect(verifyFlowState(undefined)).toBeNull();
  });

  it('rejects malformed payload', () => {
    expect(verifyFlowState('garbage')).toBeNull();
  });

  it('rejects bad signature', () => {
    const signed = signFlowState({
      state: 's',
      nonce: 'n',
      codeVerifier: 'v',
      returnTo: '/',
    });
    const tampered = signed.slice(0, -2) + (signed.endsWith('00') ? 'ff' : '00');
    expect(verifyFlowState(tampered)).toBeNull();
  });

  it('rejects when payload is altered', () => {
    const signed = signFlowState({
      state: 's',
      nonce: 'n',
      codeVerifier: 'v',
      returnTo: '/',
    });
    const dot = signed.lastIndexOf('.');
    const altered = 'eyJzdGF0ZSI6IngifQ' + signed.slice(dot);
    expect(verifyFlowState(altered)).toBeNull();
  });

  it('throws when SESSION_KEY missing', () => {
    delete process.env.SESSION_KEY;
    expect(() =>
      signFlowState({ state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/' }),
    ).toThrow(/SESSION_KEY/);
  });
});
