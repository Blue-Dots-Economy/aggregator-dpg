import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { campaignDumpServiceAccount } from '../config.js';

// Mirror the boolean-flag schema fragment the config uses so we can assert
// the parse semantics without re-importing the whole module (which reads
// process.env at import time).
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

describe('ORG_HIERARCHY_ENABLED flag semantics', () => {
  it('defaults to false when unset', () => {
    expect(flag.parse(undefined)).toBe(false);
  });
  it('is true only for the literal string "true"', () => {
    expect(flag.parse('true')).toBe(true);
    expect(flag.parse('false')).toBe(false);
  });
});

describe('campaignDumpServiceAccount', () => {
  const original = process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT;
  afterEach(() => {
    if (original === undefined) delete process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT;
    else process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT = original;
  });

  it('defaults to the campaign-manager service account', () => {
    delete process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT;
    expect(campaignDumpServiceAccount()).toBe('service-account-campaign-manager');
  });

  it('honours an explicit override', () => {
    process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT = 'service-account-other';
    expect(campaignDumpServiceAccount()).toBe('service-account-other');
  });

  it('falls back to the default on an empty value rather than disabling the gate', () => {
    process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT = '';
    expect(campaignDumpServiceAccount()).toBe('service-account-campaign-manager');
  });

  it('falls back to the default on a whitespace-only value', () => {
    process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT = '   ';
    expect(campaignDumpServiceAccount()).toBe('service-account-campaign-manager');
  });
});
