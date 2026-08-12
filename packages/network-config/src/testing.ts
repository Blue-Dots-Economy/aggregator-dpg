/**
 * Testing fake for the network-config loader.
 *
 * Lets cross-package tests inject a pinned {@link ResolvedNetworkConfig}
 * without spinning up the file/HTTP loader. Use the `build*` helpers to
 * cover blue_dot / purple_dot in unit tests; pass a full resolved object
 * when a test needs to exercise an edge case the builders don't model.
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

/** The per-network inputs the shared builder below varies on. */
interface NetworkFixture {
  /** Network id, e.g. `blue_dot`. */
  networkId: string;
  /** Brand block for the aggregator section. */
  brand: { short_name: string; long_name: string; url_slug: string };
  /** Resolved seeker domain for this network. */
  seeker: ResolvedDomain;
  /** Resolved provider domain for this network. */
  provider: ResolvedDomain;
}

/**
 * Assembles a full resolved config from the handful of fields that actually
 * differ between networks. Everything else — onboarding limits, registration
 * modes, admin emails, the domain id ordering — is identical across fixtures
 * and lives here once.
 *
 * @param fixture - The per-network values to splice in.
 * @param overrides - Caller overrides applied last, as in the public builders.
 * @returns A complete {@link ResolvedNetworkConfig}.
 */
function buildConfig(
  fixture: NetworkFixture,
  overrides: Partial<ResolvedNetworkConfig>,
): ResolvedNetworkConfig {
  return {
    aggregator: {
      name: 'Test Aggregator',
      network: {
        source: `https://example.invalid/${fixture.networkId}/network.json`,
        csv_array_delimiter: '|',
      },
      brand: fixture.brand,
      onboarding: { presume_consent: true, bulk_max_rows: 10000 },
      admin_emails: [],
      registration_modes: {
        voice: {
          label_i18n_key: 'registration_mode.voice.label',
          submission_shape: 'account_only',
          public_hint_i18n_key: 'registration_mode.voice.hint',
        },
        form: {
          label_i18n_key: 'registration_mode.form.label',
          submission_shape: 'account_and_profile',
          public_hint_i18n_key: null,
        },
      },
    },
    network: {
      id: fixture.networkId,
      domains: [
        { id: 'seeker', item_schemas: { [fixture.seeker.itemType]: {} } },
        { id: 'provider', item_schemas: { [fixture.provider.itemType]: {} } },
      ],
    },
    domains: { seeker: fixture.seeker, provider: fixture.provider },
    domainIds: ['seeker', 'provider'],
    ...overrides,
  };
}

/**
 * Deterministic blue_dot resolved config — mirrors what the production
 * loader would build from the live signalstack network.json + the
 * sample aggregator.config.yaml. Use as the default in consumer
 * tests that don't care about network specifics.
 *
 * @param overrides - Fields to replace on the returned config.
 * @returns The pinned blue_dot config.
 */
export function buildBlueDotConfig(
  overrides: Partial<ResolvedNetworkConfig> = {},
): ResolvedNetworkConfig {
  return buildConfig(
    {
      networkId: 'blue_dot',
      brand: {
        short_name: 'Blue Dots',
        long_name: 'Blue Dots Aggregator Portal',
        url_slug: 'blue-dots',
      },
      seeker: {
        id: 'seeker',
        label: 'Seekers',
        pluralLabel: 'Seekers',
        itemType: 'profile_1.0',
        schema: {},
        identity: { name: 'name', phone: 'phone', email: 'email' },
      },
      provider: {
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
      },
    },
    overrides,
  );
}

/**
 * Deterministic purple_dot resolved config — captures the array-typed
 * fields + the `beneficiary_name / mobile_number` identity naming that
 * blue_dot doesn't have. Use to assert the aggregator stays generic
 * when called with non-blue networks.
 *
 * @param overrides - Fields to replace on the returned config.
 * @returns The pinned purple_dot config.
 */
export function buildPurpleDotConfig(
  overrides: Partial<ResolvedNetworkConfig> = {},
): ResolvedNetworkConfig {
  return buildConfig(
    {
      networkId: 'purple_dot',
      brand: {
        short_name: 'Purple Dots',
        long_name: 'Purple Dot Aggregator Portal',
        url_slug: 'purple-dots',
      },
      seeker: {
        id: 'seeker',
        label: 'Seekers',
        pluralLabel: 'Seekers',
        itemType: 'profile_1.0',
        schema: {},
        identity: { name: 'beneficiary_name', phone: 'mobile_number', email: 'email' },
      },
      provider: {
        id: 'provider',
        label: 'Service Providers',
        pluralLabel: 'Service Providers',
        itemType: 'profile_1.0',
        schema: {},
        identity: { name: 'contact_name', phone: 'contact_phone', email: 'contact_email' },
      },
    },
    overrides,
  );
}
