/**
 * Tests for GET /v1/aggregator-config.
 *
 * Verifies that the endpoint correctly projects the resolved network config
 * into the public-safe wire format, including the optional `dashboardTiles`
 * per domain and top-level `dashboardBuckets` introduced in Task 5.
 *
 * @module apps/api/routes/aggregator-config.test
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';

describe('GET /v1/aggregator-config', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _setNetworkConfig(buildBlueDotConfig());
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setNetworkConfig(null);
  });

  it('returns 200 with brand + network + domains', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.brand).toBeDefined();
    expect(body.network).toBeDefined();
    expect(Array.isArray(body.domains)).toBe(true);
  });

  it('exposes the registration_modes block from the resolved config', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      registration_modes: Record<
        string,
        { label_i18n_key: string; submission_shape: string; public_hint_i18n_key: string | null }
      >;
    };
    expect(body.registration_modes).toBeDefined();
    expect(body.registration_modes.voice?.submission_shape).toBe('account_only');
    expect(body.registration_modes.form?.submission_shape).toBe('account_and_profile');
    expect(body.registration_modes.voice?.public_hint_i18n_key).toBe(
      'registration_mode.voice.hint',
    );
  });

  it('surfaces dashboardTiles per domain when the resolved config has them', async () => {
    const withTiles: ResolvedNetworkConfig = buildBlueDotConfig({
      domains: {
        seeker: {
          id: 'seeker',
          label: 'Seeker',
          pluralLabel: 'Seekers',
          itemType: 'profile_1.0',
          schema: {},
          identity: { name: 'name', phone: 'phone', email: 'email' },
          dashboardTiles: {
            profile: [
              { field: 'total_items', label: 'Profiles' },
              { field: 'complete_profiles', label: 'Complete' },
            ],
            user: [{ field: 'total_users', label: 'Total Seekers' }],
          },
        },
        provider: {
          id: 'provider',
          label: 'Provider',
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
      dashboardBuckets: {
        by_initiated_action_status: {
          create: 'Requested',
          accept: 'Accepted',
          reject: 'Declined',
          cancel: 'Cancelled',
        },
        by_received_action_status: {
          create: 'Requests',
          accept: 'Connected',
          reject: 'Declined',
          cancel: 'Cancelled',
        },
      },
    });
    _setNetworkConfig(withTiles);

    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      domains: Array<{
        id: string;
        dashboardTiles?: {
          profile?: Array<{ field: string; label: string }>;
          user?: Array<{ field: string; label: string }>;
        };
      }>;
      dashboardBuckets?: {
        by_initiated_action_status?: Record<string, string>;
        by_received_action_status?: Record<string, string>;
      };
    };

    const seeker = body.domains.find((d) => d.id === 'seeker');
    expect(seeker?.dashboardTiles?.profile?.[0]).toEqual({
      field: 'total_items',
      label: 'Profiles',
    });
    expect(seeker?.dashboardTiles?.user?.[0]).toEqual({
      field: 'total_users',
      label: 'Total Seekers',
    });

    expect(body.dashboardBuckets?.by_initiated_action_status).toEqual({
      create: 'Requested',
      accept: 'Accepted',
      reject: 'Declined',
      cancel: 'Cancelled',
    });
    expect(body.dashboardBuckets?.by_received_action_status).toEqual({
      create: 'Requests',
      accept: 'Connected',
      reject: 'Declined',
      cancel: 'Cancelled',
    });
  });

  it('omits dashboardTiles / dashboardBuckets when resolved config lacks them', async () => {
    // buildBlueDotConfig returns a config without dashboardTiles or dashboardBuckets
    _setNetworkConfig(buildBlueDotConfig());

    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      domains: Array<{ id: string; dashboardTiles?: unknown }>;
      dashboardBuckets?: unknown;
    };

    for (const domain of body.domains) {
      expect(domain.dashboardTiles).toBeUndefined();
    }
    expect(body.dashboardBuckets).toBeUndefined();
  });
});
