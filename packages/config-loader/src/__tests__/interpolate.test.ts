import { describe, it, expect } from 'vitest';
import { interpolateConfig } from '../interpolate.js';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

describe('interpolateConfig', () => {
  describe('full-string replacement', () => {
    it('replaces ${VAR} with env value', () => {
      const result = interpolateConfig({ url: '${HOST}' }, env({ HOST: 'example.com' }));
      expect(result).toEqual({ url: 'example.com' });
    });

    it('replaces ${VAR:-default} with env value when set', () => {
      const result = interpolateConfig({ port: '${PORT:-8080}' }, env({ PORT: '3000' }));
      expect(result).toEqual({ port: '3000' });
    });

    it('uses default when ${VAR:-default} env var is absent', () => {
      const result = interpolateConfig({ port: '${PORT:-8080}' }, env({}));
      expect(result).toEqual({ port: '8080' });
    });
  });

  describe('partial / mid-string replacement', () => {
    it('replaces ${VAR} embedded in a larger string', () => {
      const result = interpolateConfig(
        { url: 'https://${HOST}/api' },
        env({ HOST: 'api.example.com' }),
      );
      expect(result).toEqual({ url: 'https://api.example.com/api' });
    });

    it('replaces multiple references in one string', () => {
      const result = interpolateConfig(
        { url: 'https://${HOST}:${PORT}/api' },
        env({ HOST: 'example.com', PORT: '443' }),
      );
      expect(result).toEqual({ url: 'https://example.com:443/api' });
    });

    it('handles mix of ${VAR} and ${VAR:-default} in one string', () => {
      const result = interpolateConfig(
        { dsn: 'postgres://${DB_USER}:${DB_PASS:-secret}@${DB_HOST}/db' },
        env({ DB_USER: 'admin', DB_HOST: 'localhost' }),
      );
      expect(result).toEqual({ dsn: 'postgres://admin:secret@localhost/db' });
    });
  });

  describe('nested objects', () => {
    it('recurses into nested objects', () => {
      const result = interpolateConfig(
        { db: { host: '${DB_HOST}', port: 5432 } },
        env({ DB_HOST: 'prod-db' }),
      );
      expect(result).toEqual({ db: { host: 'prod-db', port: 5432 } });
    });

    it('recurses three levels deep', () => {
      const result = interpolateConfig({ a: { b: { c: '${VAL}' } } }, env({ VAL: 'deep' }));
      expect(result).toEqual({ a: { b: { c: 'deep' } } });
    });
  });

  describe('arrays', () => {
    it('interpolates string elements inside arrays', () => {
      const result = interpolateConfig(
        { hosts: ['${HOST_A}', '${HOST_B}'] },
        env({ HOST_A: 'a.example.com', HOST_B: 'b.example.com' }),
      );
      expect(result).toEqual({ hosts: ['a.example.com', 'b.example.com'] });
    });

    it('leaves non-string array elements unchanged', () => {
      const result = interpolateConfig({ ports: [8080, 9090] }, env({}));
      expect(result).toEqual({ ports: [8080, 9090] });
    });

    it('recurses into objects nested inside arrays', () => {
      const result = interpolateConfig(
        { services: [{ url: '${SVC_URL}' }] },
        env({ SVC_URL: 'http://svc' }),
      );
      expect(result).toEqual({ services: [{ url: 'http://svc' }] });
    });
  });

  describe('non-string scalars', () => {
    it('leaves numbers unchanged', () => {
      const result = interpolateConfig({ timeout: 5000 }, env({}));
      expect(result).toEqual({ timeout: 5000 });
    });

    it('leaves booleans unchanged', () => {
      const result = interpolateConfig({ enabled: true }, env({}));
      expect(result).toEqual({ enabled: true });
    });

    it('leaves null unchanged', () => {
      const result = interpolateConfig({ value: null }, env({}));
      expect(result).toEqual({ value: null });
    });
  });

  describe('missing variable errors', () => {
    it('throws ConfigError when ${VAR} is absent and no default', () => {
      expect(() => interpolateConfig({ url: '${MISSING_VAR}' }, env({}))).toThrow(ConfigError);
    });

    it('thrown error has code CONFIG_ENV_VAR_MISSING', () => {
      try {
        interpolateConfig({ url: '${MISSING_VAR}' }, env({}));
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe('CONFIG_ENV_VAR_MISSING');
      }
    });

    it('error message names the missing variable', () => {
      expect(() => interpolateConfig({ url: '${MISSING_VAR}' }, env({}))).toThrow('MISSING_VAR');
    });

    it('throws on first missing variable in a multi-ref string', () => {
      expect(() =>
        interpolateConfig({ url: '${PRESENT}:${MISSING}' }, env({ PRESENT: 'ok' })),
      ).toThrow(ConfigError);
    });

    it('does not throw when ${VAR:-default} var is absent', () => {
      expect(() => interpolateConfig({ x: '${ABSENT:-fallback}' }, env({}))).not.toThrow();
    });
  });

  describe('immutability', () => {
    it('returns a new object, does not mutate input', () => {
      const input = { url: '${HOST}' };
      const result = interpolateConfig(input, env({ HOST: 'example.com' }));
      expect(result).not.toBe(input);
      expect(input.url).toBe('${HOST}');
    });
  });

  describe('empty config', () => {
    it('returns empty object for empty input', () => {
      const result = interpolateConfig({}, env({}));
      expect(result).toEqual({});
    });
  });
});
