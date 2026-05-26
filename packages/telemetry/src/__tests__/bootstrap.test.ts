import { describe, expect, it, afterEach } from 'vitest';
import { trace, metrics } from '@opentelemetry/api';
import { bootTelemetry, shutdownTelemetry, isTelemetryEnabled } from '../bootstrap.js';

const cfg = {
  otel: {
    collector_endpoint: 'http://localhost:4317',
    protocol: 'grpc' as const,
    sample_rate: 1,
    export_interval_ms: 5000,
    timeout_ms: 10000,
  },
  pii_fields_excluded: [],
};

describe('bootTelemetry', () => {
  afterEach(async () => {
    await shutdownTelemetry();
  });

  it('is a no-op when OTEL_SDK_DISABLED=true', async () => {
    process.env.OTEL_SDK_DISABLED = 'true';
    await bootTelemetry({
      serviceName: 'aggregator-api',
      serviceVersion: '1.0.0',
      deploymentEnvironment: 'dev',
      config: cfg,
    });
    expect(isTelemetryEnabled()).toBe(false);
    delete process.env.OTEL_SDK_DISABLED;
  });

  it('installs providers when enabled', async () => {
    delete process.env.OTEL_SDK_DISABLED;
    await bootTelemetry({
      serviceName: 'aggregator-api',
      serviceVersion: '1.0.0',
      deploymentEnvironment: 'dev',
      config: cfg,
    });
    expect(isTelemetryEnabled()).toBe(true);
    expect(trace.getTracerProvider()).toBeDefined();
    expect(metrics.getMeterProvider()).toBeDefined();
  });

  it('is idempotent — second boot is a no-op', async () => {
    delete process.env.OTEL_SDK_DISABLED;
    await bootTelemetry({
      serviceName: 'aggregator-api',
      serviceVersion: '1.0.0',
      deploymentEnvironment: 'dev',
      config: cfg,
    });
    const first = trace.getTracerProvider();
    await bootTelemetry({
      serviceName: 'aggregator-api',
      serviceVersion: '1.0.0',
      deploymentEnvironment: 'dev',
      config: cfg,
    });
    expect(trace.getTracerProvider()).toBe(first);
  });
});
