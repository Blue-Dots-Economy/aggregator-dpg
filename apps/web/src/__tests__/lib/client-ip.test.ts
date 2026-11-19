/**
 * Unit tests for the public-proxy client-IP helper.
 */
import { describe, it, expect } from 'vitest';
import {
  clientIp,
  DEFAULT_TRUSTED_PROXY_HOPS,
  forwardedForHeader,
  resolveTrustedProxyHops,
} from '@/lib/client-ip';

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe('clientIp', () => {
  it('ignores caller-supplied entries left of the trusted hop', () => {
    const h = headers({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.7' });
    expect(clientIp(h, 1)).toBe('203.0.113.7');
  });

  it('returns the only entry of a single-entry chain', () => {
    expect(clientIp(headers({ 'x-forwarded-for': ' 203.0.113.7 ' }), 1)).toBe('203.0.113.7');
  });

  it('counts the configured number of hops from the right', () => {
    const h = headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7, 10.0.0.4' });
    expect(clientIp(h, 2)).toBe('203.0.113.7');
  });

  it('returns nothing when the chain is shorter than the hop count', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '203.0.113.7' }), 2)).toBeUndefined();
  });

  it('returns nothing when no proxy is trusted', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '203.0.113.7' }), 0)).toBeUndefined();
  });

  it('returns nothing when the trusted entry is not an IP', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '1.1.1.1, not-an-ip' }), 1)).toBeUndefined();
  });

  it('accepts an IPv6 entry', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '2001:db8::1' }), 1)).toBe('2001:db8::1');
  });

  it('falls back to x-real-ip only when x-forwarded-for is missing', () => {
    expect(clientIp(headers({ 'x-real-ip': '203.0.113.7' }), 1)).toBe('203.0.113.7');
    expect(
      clientIp(headers({ 'x-forwarded-for': '198.51.100.2', 'x-real-ip': '203.0.113.7' }), 1),
    ).toBe('198.51.100.2');
  });

  it('returns nothing when neither header is present', () => {
    expect(clientIp(headers({}), 1)).toBeUndefined();
  });
});

describe('forwardedForHeader', () => {
  it('forwards only the derived single IP', () => {
    const h = headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' });
    expect(forwardedForHeader(h)).toEqual({ 'x-forwarded-for': '203.0.113.7' });
  });

  it('omits the header when no IP is known', () => {
    expect(forwardedForHeader(headers({}))).toEqual({});
  });
});

describe('resolveTrustedProxyHops', () => {
  it('defaults to one hop when unset or blank', () => {
    expect(DEFAULT_TRUSTED_PROXY_HOPS).toBe(1);
    expect(resolveTrustedProxyHops({})).toBe(1);
    expect(resolveTrustedProxyHops({ TRUSTED_PROXY_HOPS: ' ' })).toBe(1);
  });

  it('reads a whole number, zero included', () => {
    expect(resolveTrustedProxyHops({ TRUSTED_PROXY_HOPS: '2' })).toBe(2);
    expect(resolveTrustedProxyHops({ TRUSTED_PROXY_HOPS: '0' })).toBe(0);
  });

  it('falls back to the default for invalid values', () => {
    expect(resolveTrustedProxyHops({ TRUSTED_PROXY_HOPS: '-1' })).toBe(1);
    expect(resolveTrustedProxyHops({ TRUSTED_PROXY_HOPS: '1.5' })).toBe(1);
    expect(resolveTrustedProxyHops({ TRUSTED_PROXY_HOPS: 'two' })).toBe(1);
  });
});
