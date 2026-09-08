import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bulkSamplePath } from '../bulk-sample.js';

describe('bulkSamplePath', () => {
  it('resolves the sample beside the active config directory', () => {
    expect(bulkSamplePath('seeker', '/app/config/aggregator.config.yaml')).toBe(
      '/app/config/bulk-samples/seeker.csv',
    );
  });

  it('keys the filename on the participant type', () => {
    expect(bulkSamplePath('provider', '/srv/config/blue_dot/aggregator.config.yaml')).toBe(
      '/srv/config/blue_dot/bulk-samples/provider.csv',
    );
  });
});

// `readBulkSample` reads through `node:fs/promises` at a path derived from
// `resolveConfigPath()`; both are mocked so the test controls the exact
// success/ENOENT/other-error scenarios without touching the real filesystem
// or network config. `vi.hoisted` is required (not a bare top-level const)
// because this file already statically imports the real `../bulk-sample.js`
// above, which transitively imports `node:fs/promises` before a later
// const initialiser would otherwise run.
const { mockReadFile, mockLoggerError } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockLoggerError: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));
vi.mock('@aggregator-dpg/network-config/paths', () => ({
  resolveConfigPath: () => '/app/config/aggregator.config.yaml',
}));
vi.mock('../../../logger.js', () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('readBulkSample', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockLoggerError.mockReset();
  });

  it('returns the curated sample CSV text when the file exists', async () => {
    const { readBulkSample } = await import('../bulk-sample.js');
    mockReadFile.mockResolvedValue('name,email\nA,a@b.com\n');
    const result = await readBulkSample('seeker');
    expect(result).toBe('name,email\nA,a@b.com\n');
    expect(mockReadFile).toHaveBeenCalledWith('/app/config/bulk-samples/seeker.csv', 'utf8');
  });

  it('returns null without logging when the file does not exist (ENOENT)', async () => {
    const { readBulkSample } = await import('../bulk-sample.js');
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValue(err);
    const result = await readBulkSample('provider');
    expect(result).toBeNull();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('returns null and logs on any other read error', async () => {
    const { readBulkSample } = await import('../bulk-sample.js');
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mockReadFile.mockRejectedValue(err);
    const result = await readBulkSample('seeker');
    expect(result).toBeNull();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'csv-template.readBulkSample',
        status: 'failure',
        participant_type: 'seeker',
        error: 'permission denied',
      }),
    );
  });

  it('logs a string-coerced error when a non-Error value is thrown', async () => {
    const { readBulkSample } = await import('../bulk-sample.js');
    mockReadFile.mockRejectedValue('raw string failure');
    const result = await readBulkSample('seeker');
    expect(result).toBeNull();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'raw string failure' }),
    );
  });
});
