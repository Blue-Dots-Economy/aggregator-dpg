import { describe, it, expect } from 'vitest';
import { clientIpOf } from '@/lib/client-ip';

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/x', { headers });
}

describe('clientIpOf', () => {
  it('takes the first entry of x-forwarded-for, trimmed', () => {
    expect(clientIpOf(request({ 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1' }))).toBe(
      '203.0.113.7',
    );
  });

  it("falls back to the request's ip when there is no x-forwarded-for", () => {
    const req = Object.assign(request(), { ip: '198.51.100.4' });
    expect(clientIpOf(req)).toBe('198.51.100.4');
  });

  it('falls back to the ip when the first x-forwarded-for entry is empty', () => {
    const req = Object.assign(request({ 'x-forwarded-for': ' , 10.0.0.1' }), {
      ip: '198.51.100.4',
    });
    expect(clientIpOf(req)).toBe('198.51.100.4');
  });

  it('returns an empty string when neither is known', () => {
    expect(clientIpOf(request())).toBe('');
  });

  it('ignores an ip that is not a string', () => {
    expect(clientIpOf(Object.assign(request(), { ip: 42 }))).toBe('');
  });
});
