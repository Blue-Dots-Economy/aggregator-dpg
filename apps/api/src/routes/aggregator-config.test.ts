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
            total_items: 'Total Seekers',
            complete_profiles: 'Complete',
            has_applications: 'Engaged',
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
        by_action_status: {
          create: 'Requested',
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
        dashboardTiles?: Record<string, string>;
      }>;
      dashboardBuckets?: { by_action_status?: Record<string, string> };
    };

    const seeker = body.domains.find((d) => d.id === 'seeker');
    expect(seeker?.dashboardTiles).toEqual({
      total_items: 'Total Seekers',
      complete_profiles: 'Complete',
      has_applications: 'Engaged',
    });

    expect(body.dashboardBuckets?.by_action_status).toEqual({
      create: 'Requested',
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
