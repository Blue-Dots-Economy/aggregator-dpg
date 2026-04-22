import { describe, it, expect } from 'vitest';
import {
  BaseError,
  UpstreamError,
  ConfigError,
  AuthError,
  ValidationError,
  DomainError,
} from '../errors/index.js';

describe('BaseError', () => {
  it('sets name to the concrete class name', () => {
    const e = new BaseError('TEST_CODE', 'test message');
    expect(e.name).toBe('BaseError');
  });

  it('sets code and message', () => {
    const e = new BaseError('MY_CODE', 'my message');
    expect(e.code).toBe('MY_CODE');
    expect(e.message).toBe('my message');
  });

  it('attaches details when provided', () => {
    const e = new BaseError('C', 'm', { details: { field: 'foo' } });
    expect(e.details).toEqual({ field: 'foo' });
  });

  it('serializes to JSON with required fields', () => {
    const e = new BaseError('CODE', 'msg');
    const json = e.toJSON();
    expect(json.name).toBe('BaseError');
    expect(json.code).toBe('CODE');
    expect(json.message).toBe('msg');
    expect(json.details).toBeUndefined();
    expect(json.cause).toBeUndefined();
  });

  it('serializes cause as string', () => {
    const cause = new Error('root');
    const e = new BaseError('CODE', 'msg', { cause });
    const json = e.toJSON();
    expect(json.cause).toContain('root');
  });

  it('serializes details when present', () => {
    const e = new BaseError('CODE', 'msg', { details: { key: 1 } });
    expect(e.toJSON().details).toEqual({ key: 1 });
  });
});

describe('Error subclasses', () => {
  it('UpstreamError is instanceof BaseError and UpstreamError', () => {
    const e = new UpstreamError('fail');
    expect(e).toBeInstanceOf(BaseError);
    expect(e).toBeInstanceOf(UpstreamError);
    expect(e.code).toBe('UPSTREAM_ERROR');
    expect(e.name).toBe('UpstreamError');
  });

  it('UpstreamError accepts custom code', () => {
    const e = new UpstreamError('fail', { code: 'SIGNALS_TIMEOUT' });
    expect(e.code).toBe('SIGNALS_TIMEOUT');
  });

  it('ConfigError defaults to CONFIG_ERROR code', () => {
    const e = new ConfigError('missing env');
    expect(e.code).toBe('CONFIG_ERROR');
    expect(e).toBeInstanceOf(BaseError);
  });

  it('AuthError defaults to AUTH_ERROR code', () => {
    const e = new AuthError('forbidden');
    expect(e.code).toBe('AUTH_ERROR');
    expect(e).toBeInstanceOf(BaseError);
  });

  it('ValidationError defaults to VALIDATION_ERROR code', () => {
    const e = new ValidationError('bad input');
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e).toBeInstanceOf(BaseError);
  });

  it('DomainError defaults to DOMAIN_ERROR code', () => {
    const e = new DomainError('invariant violated');
    expect(e.code).toBe('DOMAIN_ERROR');
    expect(e).toBeInstanceOf(BaseError);
  });

  it('subclass instances are not cross-compatible', () => {
    const upstream = new UpstreamError('u');
    expect(upstream).not.toBeInstanceOf(ConfigError);
    expect(upstream).not.toBeInstanceOf(AuthError);
  });

  it('toJSON reflects subclass name', () => {
    const e = new ValidationError('bad');
    expect(e.toJSON().name).toBe('ValidationError');
  });
});
