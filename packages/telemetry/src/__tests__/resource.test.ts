import { describe, expect, it } from 'vitest';
import { buildResource } from '../resource.js';

describe('buildResource', () => {
  it('sets service.name, service.version, dpg.block, deployment.environment', () => {
    const r = buildResource({
      serviceName: 'aggregator-api',
      serviceVersion: '1.2.3',
      deploymentEnvironment: 'dev',
    });
    const attrs = r.attributes;
    expect(attrs['service.name']).toBe('aggregator-api');
    expect(attrs['service.namespace']).toBe('aggregator');
    expect(attrs['service.version']).toBe('1.2.3');
    expect(attrs['deployment.environment']).toBe('dev');
    expect(attrs['dpg.block']).toBe('api');
  });

  it('uses HOSTNAME for service.instance.id when set', () => {
    process.env.HOSTNAME = 'api-pod-7';
    const r = buildResource({
      serviceName: 'aggregator-api',
      serviceVersion: '1.0.0',
      deploymentEnvironment: 'dev',
    });
    expect(r.attributes['service.instance.id']).toBe('api-pod-7');
    delete process.env.HOSTNAME;
  });

  it('falls back to a uuid when HOSTNAME is missing', () => {
    delete process.env.HOSTNAME;
    const r = buildResource({
      serviceName: 'aggregator-worker',
      serviceVersion: '1.0.0',
      deploymentEnvironment: 'dev',
    });
    expect(r.attributes['service.instance.id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
