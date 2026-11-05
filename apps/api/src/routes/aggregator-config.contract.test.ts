/**
 * Contract tests for GET /v1/aggregator-config (api app).
 *
 * Loads each network in `config/` with the real config loader, serves the
 * route, and checks the body equals the web fixture for that network. The
 * response schema validates and serialises the reply, so this catches a
 * schema that drops or rejects a field the web reads. The OpenAPI checks
 * cover the documented shape of the same response.
 *
 * @module apps/api/routes/aggregator-config.contract.test
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FileNetworkConfigLoader } from '@aggregator-dpg/network-config/loader';
import { buildApp } from '../app.js';
import { _setNetworkConfig } from '../services/network-config.js';

const CONFIG_ROOT = fileURLToPath(new URL('../../../../config', import.meta.url));
const WEB_FIXTURES = fileURLToPath(new URL('../../../web/src/__tests__/fixtures', import.meta.url));
const NETWORKS = ['blue_dot', 'purple_dot', 'orange_dot'] as const;

/** The parts of a fixture that come from `network.json`. */
const FixtureNetworkPartsSchema = z.object({
  network: z.object({ id: z.string(), display_name: z.string().optional() }),
  domains: z.array(
    z.object({
      id: z.string(),
      item_type: z.string(),
      guardian_consent_required: z.boolean(),
      go_live_required: z.array(z.string()),
      dashboardTiles: z.unknown().optional(),
      status_rules: z.unknown().optional(),
    }),
  ),
  dashboardBuckets: z.unknown().optional(),
});

/**
 * Rebuilds the upstream `network.json` that produced a fixture.
 *
 * Item schemas are empty: every network in `config/` sets `field_overrides`,
 * so the loader does not need them to resolve identity fields.
 */
function networkJsonFromFixture(fixture: unknown): Record<string, unknown> {
  const parts = FixtureNetworkPartsSchema.parse(fixture);
  return {
    id: parts.network.id,
    ...(parts.network.display_name ? { display_name: parts.network.display_name } : {}),
    domains: parts.domains.map((d) => ({
      id: d.id,
      guardian_consent_required: d.guardian_consent_required,
      go_live_required: d.go_live_required,
      item_schemas: { [d.item_type]: {} },
      ...(d.dashboardTiles !== undefined ? { dashboard_tiles: d.dashboardTiles } : {}),
      ...(d.status_rules !== undefined ? { status_rules: d.status_rules } : {}),
    })),
    ...(parts.dashboardBuckets !== undefined ? { dashboard_buckets: parts.dashboardBuckets } : {}),
  };
}

/** Reads the web fixture for a network as untyped JSON. */
async function readFixture(network: string): Promise<unknown> {
  const raw = await readFile(join(WEB_FIXTURES, `aggregator-config.${network}.json`), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return parsed;
}

describe('GET /v1/aggregator-config — payloads for the networks in config/', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setNetworkConfig(null);
  });

  it.each(NETWORKS)('sends the full payload for %s', async (network) => {
    const fixture = await readFixture(network);
    const networkJson = networkJsonFromFixture(fixture);
    const loader = new FileNetworkConfigLoader({
      configPath: join(CONFIG_ROOT, network, 'aggregator.config.yaml'),
      networkSourceOverride: 'https://network.example.invalid/network.json',
      consentSourceOverride: 'https://network.example.invalid/consent.json',
      // network.json is served from the fixture; consent is not part of this route.
      fetchImpl: async (input) =>
        String(input).endsWith('/network.json')
          ? new Response(JSON.stringify(networkJson), { status: 200 })
          : new Response('not found', { status: 404 }),
    });
    const loaded = await loader.load();
    if (!loaded.success) throw new Error(`config load failed: ${loaded.error.message}`);
    _setNetworkConfig(loaded.value);

    const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(fixture);
  });
});

/** The JSON Schema keywords this file reads from the OpenAPI spec. */
const JsonSchemaNode: z.ZodType<JsonSchema> = z.lazy(() =>
  z
    .object({
      properties: z.record(z.string(), JsonSchemaNode).optional(),
      items: JsonSchemaNode.optional(),
      additionalProperties: z.union([z.boolean(), JsonSchemaNode]).optional(),
      required: z.array(z.string()).optional(),
    })
    .passthrough(),
);
interface JsonSchema {
  properties?: Record<string, JsonSchema> | undefined;
  items?: JsonSchema | undefined;
  additionalProperties?: boolean | JsonSchema | undefined;
  required?: string[] | undefined;
}

/** Returns the property names of a JSON Schema object node. */
function keysOf(node: JsonSchema | undefined): string[] {
  return Object.keys(node?.properties ?? {}).sort();
}

describe('GET /v1/aggregator-config — OpenAPI response schema', () => {
  let app: FastifyInstance;
  let schema: JsonSchema;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const spec = z
      .object({
        paths: z.object({
          '/v1/aggregator-config': z.object({
            get: z.object({
              responses: z.object({
                '200': z.object({
                  content: z.object({ 'application/json': z.object({ schema: JsonSchemaNode }) }),
                }),
              }),
            }),
          }),
        }),
      })
      .parse(app.swagger());
    schema =
      spec.paths['/v1/aggregator-config'].get.responses['200'].content['application/json'].schema;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('documents the brand design tokens and attribution', () => {
    const brand = schema.properties?.brand;
    expect(keysOf(brand)).toEqual(
      expect.arrayContaining(['palette', 'typography', 'logo', 'attribution']),
    );
    expect(keysOf(brand?.properties?.palette)).toEqual([
      'accent',
      'gradients',
      'primary',
      'secondary',
    ]);
    expect(keysOf(brand?.properties?.typography)).toEqual(['body', 'headings', 'primaryFont']);
  });

  it('documents per-domain dashboard tiles and status rules', () => {
    const domain = schema.properties?.domains?.items;
    expect(keysOf(domain)).toEqual(expect.arrayContaining(['dashboardTiles', 'status_rules']));
    expect(keysOf(domain?.properties?.dashboardTiles)).toEqual([
      'profile',
      'profile_title',
      'user',
      'user_title',
    ]);
    expect(keysOf(domain?.properties?.status_rules?.items)).toEqual(
      expect.arrayContaining(['status', 'label', 'description']),
    );
  });

  it('documents the dashboard bucket keys the API sends', () => {
    expect(keysOf(schema.properties?.dashboardBuckets)).toEqual([
      'by_initiated_action_status',
      'by_received_action_status',
      'by_status',
    ]);
  });

  it('documents the full registration mode with a resolved signals_cta', () => {
    const modes = schema.properties?.registration_modes?.additionalProperties;
    const mode = typeof modes === 'object' ? modes : undefined;
    expect(keysOf(mode)).toEqual([
      'label_i18n_key',
      'public_hint_i18n_key',
      'signals_cta',
      'submission_shape',
    ]);
    expect(mode?.required).toContain('signals_cta');
  });
});
