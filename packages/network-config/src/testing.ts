/**
 * Testing fake for the network-config loader.
 *
 * Lets cross-package tests inject a pinned {@link ResolvedNetworkConfig}
 * without spinning up the file/HTTP loader. Use the `build*` helpers to
 * cover blue_dot / purple_dot / yellow_dot in unit tests; pass a full
 * resolved object when a test needs to exercise an edge case the
 * builders don't model.
 *
 * @module @aggregator-dpg/network-config/testing
 */

import { ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  NetworkConfigLoaderBase,
  type NetworkConfigError,
  type ResolvedDomain,
  type ResolvedNetworkConfig,
} from './interface.js';

export class InMemoryNetworkConfigLoader extends NetworkConfigLoaderBase {
  constructor(private readonly pinned: ResolvedNetworkConfig) {
    super();
  }

  async load(): Promise<Result<ResolvedNetworkConfig, BaseError | NetworkConfigError>> {
    return ok(this.pinned);
  }
}

/**
 * Deterministic blue_dot resolved config — mirrors what the production
 * loader would build from the live signalstack network.json + the
 * sample aggregator.config.yaml. Use as the default in consumer
 * tests that don't care about network specifics.
 */
export function buildBlueDotConfig(
  overrides: Partial<ResolvedNetworkConfig> = {},
): ResolvedNetworkConfig {
  const seekerDomain: ResolvedDomain = {
    id: 'seeker',
    label: 'Seekers',
    pluralLabel: 'Seekers',
    itemType: 'profile_1.0',
    schema: {},
    identity: { name: 'name', phone: 'phone', email: 'email' },
  };
  const providerDomain: ResolvedDomain = {
    id: 'provider',
    label: 'Providers',
    pluralLabel: 'Providers',
    itemType: 'job_posting_1.0',
    schema: {},
    identity: {
      name: 'jobProviderName',
      phone: 'hiringManagerPhoneNumber',
      email: 'hiringManagerEmail',
    },
  };
  return {
    aggregator: {
      name: 'Test Aggregator',
      network: {
        source: 'https://example.invalid/blue_dot/network.json',
        csv_array_delimiter: '|',
      },
      brand: {
        short_name: 'Blue Dots',
        long_name: 'Blue Dots Aggregator Portal',
        url_slug: 'blue-dots',
      },
      onboarding: { presume_consent: true, bulk_max_rows: 10000 },
      admin_emails: [],
    },
    network: {
      id: 'blue_dot',
      domains: [
        { id: 'seeker', item_schemas: { 'profile_1.0': {} } },
        { id: 'provider', item_schemas: { 'job_posting_1.0': {} } },
      ],
    },
    domains: { seeker: seekerDomain, provider: providerDomain },
    domainIds: ['seeker', 'provider'],
    ...overrides,
  };
}

/**
 * Deterministic purple_dot resolved config — captures the array-typed
 * fields + the `beneficiary_name / mobile_number` identity naming that
 * blue_dot doesn't have. Use to assert the aggregator stays generic
 * when called with non-blue networks.
 */
export function buildPurpleDotConfig(
  overrides: Partial<ResolvedNetworkConfig> = {},
): ResolvedNetworkConfig {
  const seekerDomain: ResolvedDomain = {
    id: 'seeker',
    label: 'Beneficiaries',
    pluralLabel: 'Beneficiaries',
    itemType: 'profile_1.0',
    schema: {},
    identity: { name: 'beneficiary_name', phone: 'mobile_number', email: 'email' },
  };
  const providerDomain: ResolvedDomain = {
    id: 'provider',
    label: 'Service Providers',
    pluralLabel: 'Service Providers',
    itemType: 'profile_1.0',
    schema: {},
    identity: { name: 'contact_name', phone: 'contact_phone', email: 'contact_email' },
  };
  return {
    aggregator: {
      name: 'Test Aggregator',
      network: {
        source: 'https://example.invalid/purple_dot/network.json',
        csv_array_delimiter: '|',
      },
      brand: {
        short_name: 'Purple Dots',
        long_name: 'Purple Dot Aggregator Portal',
        url_slug: 'purple-dots',
      },
      onboarding: { presume_consent: true, bulk_max_rows: 10000 },
      admin_emails: [],
    },
    network: {
      id: 'purple_dot',
      domains: [
        { id: 'seeker', item_schemas: { 'profile_1.0': {} } },
        { id: 'provider', item_schemas: { 'profile_1.0': {} } },
      ],
    },
    domains: { seeker: seekerDomain, provider: providerDomain },
    domainIds: ['seeker', 'provider'],
    ...overrides,
  };
}
