/**
 * Defaults of the bulk-upload operator command's timeouts. The test suite does
 * not set these variables, so the parsed values are the schema defaults.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { config } from './config.js';

describe('bulk-upload command timeouts', () => {
  it('bounds each call at 30 s by default', () => {
    expect(config.BULK_UPLOAD_CMD_CALL_TIMEOUT_MS).toBe(30_000);
  });

  it('waits up to an hour for processing by default', () => {
    expect(config.BULK_UPLOAD_CMD_WAIT_MS).toBe(60 * 60 * 1000);
  });
});

describe('bulk-upload command timeout caps', () => {
  afterEach(() => {
    delete process.env.BULK_UPLOAD_CMD_CALL_TIMEOUT_MS;
    delete process.env.BULK_UPLOAD_CMD_WAIT_MS;
    vi.resetModules();
  });

  it.each([
    ['BULK_UPLOAD_CMD_CALL_TIMEOUT_MS', String(10 * 60 * 1000 + 1)],
    ['BULK_UPLOAD_CMD_WAIT_MS', String(24 * 60 * 60 * 1000 + 1)],
    ['BULK_UPLOAD_CMD_CALL_TIMEOUT_MS', '2147483648'],
  ])('refuses %s=%s', async (name, value) => {
    process.env[name] = value;
    vi.resetModules();
    await expect(import('./config.js')).rejects.toThrow(name);
  });

  it('accepts the caps themselves', async () => {
    process.env.BULK_UPLOAD_CMD_CALL_TIMEOUT_MS = String(10 * 60 * 1000);
    process.env.BULK_UPLOAD_CMD_WAIT_MS = String(24 * 60 * 60 * 1000);
    vi.resetModules();
    const fresh = await import('./config.js');
    expect(fresh.config.BULK_UPLOAD_CMD_CALL_TIMEOUT_MS).toBe(600_000);
    expect(fresh.config.BULK_UPLOAD_CMD_WAIT_MS).toBe(86_400_000);
  });
});
