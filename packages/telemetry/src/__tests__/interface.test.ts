import { describe, expect, it } from 'vitest';
import { TelemetryConfigSchema } from '../interface.js';

describe('TelemetryConfigSchema', () => {
  it('parses a minimal valid config', () => {
    const result = TelemetryConfigSchema.parse({
      otel: { collector_endpoint: 'http://otel-collector:4317' },
    });
    expect(result.otel.protocol).toBe('grpc');
    expect(result.otel.sample_rate).toBe(0.1);
    expect(result.otel.export_interval_ms).toBe(5000);
    expect(result.outcomes_svc_url).toBeUndefined();
  });

  it('rejects sample_rate > 1', () => {
    expect(() =>
      TelemetryConfigSchema.parse({
        otel: { collector_endpoint: 'http://otel-collector:4317', sample_rate: 1.5 },
      }),
    ).toThrow();
  });

  it('accepts outcomes_svc_url and HMAC secret', () => {
    const result = TelemetryConfigSchema.parse({
      otel: { collector_endpoint: 'http://otel-collector:4317' },
      outcomes_svc_url: 'http://observability-svc:8080',
      outcomes_hmac_key_id: 'svc-api',
      outcomes_hmac_secret: 'shhh',
    });
    expect(result.outcomes_svc_url).toBe('http://observability-svc:8080');
  });
});

describe('TelemetryConfigSchema outcomes field co-presence', () => {
  const otel = { collector_endpoint: 'http://otel-collector:4317' };

  it('rejects outcomes_svc_url without HMAC key id', () => {
    expect(() =>
      TelemetryConfigSchema.parse({
        otel,
        outcomes_svc_url: 'http://observability-svc:8080',
        outcomes_hmac_secret: 'shh',
      }),
    ).toThrow(/outcomes_hmac/);
  });

  it('rejects outcomes_svc_url without HMAC secret', () => {
    expect(() =>
      TelemetryConfigSchema.parse({
        otel,
        outcomes_svc_url: 'http://observability-svc:8080',
        outcomes_hmac_key_id: 'svc-api',
      }),
    ).toThrow(/outcomes_hmac/);
  });

  it('rejects HMAC fields without outcomes_svc_url', () => {
    expect(() =>
      TelemetryConfigSchema.parse({
        otel,
        outcomes_hmac_key_id: 'svc-api',
        outcomes_hmac_secret: 'shh',
      }),
    ).toThrow(/outcomes_svc_url/);
  });

  it('accepts all three set together', () => {
    expect(() =>
      TelemetryConfigSchema.parse({
        otel,
        outcomes_svc_url: 'http://observability-svc:8080',
        outcomes_hmac_key_id: 'svc-api',
        outcomes_hmac_secret: 'shh',
      }),
    ).not.toThrow();
  });

  it('accepts none set (Phase 0-3 default)', () => {
    expect(() => TelemetryConfigSchema.parse({ otel })).not.toThrow();
  });
});
