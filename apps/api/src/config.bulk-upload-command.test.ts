/**
 * Defaults of the bulk-upload operator command's timeouts. The test suite does
 * not set these variables, so the parsed values are the schema defaults.
 */
import { describe, it, expect } from 'vitest';
import { config } from './config.js';

describe('bulk-upload command timeouts', () => {
  it('bounds each call at 30 s by default', () => {
    expect(config.BULK_UPLOAD_CMD_CALL_TIMEOUT_MS).toBe(30_000);
  });

  it('waits up to an hour for processing by default', () => {
    expect(config.BULK_UPLOAD_CMD_WAIT_MS).toBe(60 * 60 * 1000);
  });
});
