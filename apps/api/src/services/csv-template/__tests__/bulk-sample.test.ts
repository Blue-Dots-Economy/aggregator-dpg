import { describe, it, expect } from 'vitest';
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
