/**
 * Unit test for the dev-mode pino-pretty transport branch of `logger.ts`.
 *
 * `./config.js` is mocked so `NODE_ENV=development` is exercised
 * deterministically without depending on the real process env (which is
 * `test` for the whole suite). A separate file from `logger.test.ts` because
 * this exercises the module's dev-only branch via a fresh dynamic import
 * rather than the shared `loggerOptions` used by the rest of the suite.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./config.js', () => ({
  config: { LOG_LEVEL: 'info', NODE_ENV: 'development' },
}));

describe('loggerOptions in development', () => {
  it('configures the pino-pretty transport', async () => {
    vi.resetModules();
    const { loggerOptions } = await import('./logger.js');
    expect(loggerOptions.transport).toEqual({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        singleLine: false,
        ignore: 'pid,hostname,service,env',
        destination: 1,
      },
    });
    expect(loggerOptions.base).toEqual({ service: 'aggregator-api', env: 'development' });
  });

  it('sends pretty output to stderr when LOG_DESTINATION is stderr', async () => {
    vi.resetModules();
    vi.doMock('./config.js', () => ({
      config: { LOG_LEVEL: 'info', NODE_ENV: 'development', LOG_DESTINATION: 'stderr' },
    }));
    const { loggerOptions } = await import('./logger.js');
    expect(loggerOptions.transport).toMatchObject({ options: { destination: 2 } });
    vi.doUnmock('./config.js');
  });
});
