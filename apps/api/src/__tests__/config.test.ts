import { describe, it, expect, afterEach } from 'vitest';
import {
  campaignDumpServiceAccount,
  defaultOrgOwnerEmail,
  legacyHierarchyFlagSet,
} from '../config.js';

describe('legacyHierarchyFlagSet (ORG_HIERARCHY_ENABLED removed in 0028)', () => {
  const original = process.env.ORG_HIERARCHY_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.ORG_HIERARCHY_ENABLED;
    else process.env.ORG_HIERARCHY_ENABLED = original;
  });

  it('is false when the variable is absent', () => {
    delete process.env.ORG_HIERARCHY_ENABLED;
    expect(legacyHierarchyFlagSet()).toBe(false);
  });

  it('is true for any value, so boot warns that it is ignored', () => {
    process.env.ORG_HIERARCHY_ENABLED = 'false';
    expect(legacyHierarchyFlagSet()).toBe(true);
  });
});

describe('defaultOrgOwnerEmail', () => {
  const original = process.env.DEFAULT_ORG_OWNER_EMAIL;
  afterEach(() => {
    if (original === undefined) delete process.env.DEFAULT_ORG_OWNER_EMAIL;
    else process.env.DEFAULT_ORG_OWNER_EMAIL = original;
  });

  it('is null when unset or blank', () => {
    delete process.env.DEFAULT_ORG_OWNER_EMAIL;
    expect(defaultOrgOwnerEmail()).toBeNull();
    process.env.DEFAULT_ORG_OWNER_EMAIL = '   ';
    expect(defaultOrgOwnerEmail()).toBeNull();
  });

  it('trims and lowercases a configured address', () => {
    process.env.DEFAULT_ORG_OWNER_EMAIL = '  Owner@Example.ORG ';
    expect(defaultOrgOwnerEmail()).toBe('owner@example.org');
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
