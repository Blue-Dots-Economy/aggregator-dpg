import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { CAPABILITIES } from '../interface.js';
import type { Capability } from '../interface.js';
import { orgCapabilities, parseRbacConfig, roleCapabilities } from '../rbac-config.js';
import type { RbacConfig } from '../rbac-config.js';
import { evaluate } from '../evaluate.js';

const shippedPath = fileURLToPath(new URL('../../../../config/rbac.yaml', import.meta.url));
const shipped = (): RbacConfig => parseRbacConfig(load(readFileSync(shippedPath, 'utf8')), 'test');
// Loosely typed on purpose: each test breaks the config in its own way.
type Mutable = { [key: string]: Mutable } & Mutable[] & { push(v: unknown): void };
const clone = (): Mutable => JSON.parse(JSON.stringify(shipped())) as Mutable;

function expectInvalid(raw: unknown, message: RegExp): void {
  try {
    parseRbacConfig(raw, 'test');
    expect.unreachable('config should be rejected');
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).code).toBe('RBAC_CONFIG_INVALID');
    expect(JSON.stringify((e as ConfigError).details)).toMatch(message);
  }
}

describe('shipped config/rbac.yaml', () => {
  it('is valid', () => {
    expect(() => shipped()).not.toThrow();
  });

  it('gives the root every capability', () => {
    expect(orgCapabilities(shipped(), 'network_facilitator').sort()).toEqual(
      [...CAPABILITIES].sort(),
    );
  });

  it('keeps personal data out of every default role', () => {
    const cfg = shipped();
    expect(roleCapabilities(cfg, 'admin')).not.toContain('profiles.view_pii');
    expect(roleCapabilities(cfg, 'coordinator')).not.toContain('profiles.view_pii');
  });

  it('keeps the aggregator set inside the super aggregator set', () => {
    const cfg = shipped();
    const sup = cfg.permission_sets['super_aggregator'] ?? [];
    for (const c of cfg.permission_sets['aggregator'] ?? []) expect(sup).toContain(c);
  });

  // Today an approved coordinator can call every coordinator route. This lists
  // exactly what the shipped defaults no longer allow, so a new gap fails here.
  it("differs from today's coordinator access only by export and personal data", () => {
    const cfg = shipped();
    const usedToday: Capability[] = [
      'profiles.view',
      'profiles.onboard',
      'profiles.export',
      'profiles.view_pii',
      'campaigns.run',
    ];
    const denied = usedToday.filter(
      (capability) =>
        !evaluate({
          capability,
          now: 0,
          actor: {
            userId: 'u',
            userType: 'coordinator',
            active: true,
            roleCapabilities: roleCapabilities(cfg, 'coordinator'),
            orgs: [
              {
                id: 'a',
                orgType: 'aggregator',
                relation: 'member',
                capabilities: orgCapabilities(cfg, 'aggregator'),
              },
            ],
            grants: [],
          },
        }).allow,
    );
    expect(denied).toEqual(['profiles.export', 'profiles.view_pii']);
  });
});

describe('parseRbacConfig', () => {
  it('rejects an unknown capability', () => {
    const raw = clone();
    raw.roles.coordinator.push('profiles.teleport');
    expectInvalid(raw, /invalid_enum_value|Invalid enum/);
  });

  it('rejects a duplicate capability', () => {
    const raw = clone();
    raw.roles.coordinator.push('profiles.view');
    expectInvalid(raw, /duplicate capability/);
  });

  it('rejects a missing role', () => {
    const raw = clone();
    delete raw.roles.admin;
    expectInvalid(raw, /role missing/);
  });

  it('rejects a missing org_type default', () => {
    const raw = clone();
    delete raw.org_type_defaults.aggregator;
    expectInvalid(raw, /default missing/);
  });

  it('rejects a default that names no set', () => {
    const raw = clone();
    raw.org_type_defaults.aggregator = 'nope';
    expectInvalid(raw, /unknown permission set/);
  });

  it('rejects a root set without every capability', () => {
    const raw = clone();
    raw.permission_sets.network = ['profiles.view'];
    expectInvalid(raw, /must hold every capability/);
  });

  it('rejects a per-user grant of a role capability', () => {
    const raw = clone();
    raw.grants.pii_access.capabilities = ['org.manage'];
    expectInvalid(raw, /cannot be granted per user/);
  });

  it('rejects a grant with more than one capability', () => {
    const raw = clone();
    raw.grants.pii_access.capabilities = ['profiles.view_pii', 'profiles.view_pii'];
    expectInvalid(raw, /exactly one capability|duplicate capability/);
  });

  it('rejects an unknown version', () => {
    const raw = clone();
    raw.version = 2;
    expectInvalid(raw, /version/);
  });

  it('rejects an empty document', () => {
    expectInvalid(null, /invalid_type|Expected object/);
  });
});

describe('orgCapabilities', () => {
  it('uses the override when it names a set', () => {
    expect(orgCapabilities(shipped(), 'aggregator', 'super_aggregator')).toContain('orgs.onboard');
  });

  it('falls back to the org_type default for an unknown or empty override', () => {
    const cfg = shipped();
    expect(orgCapabilities(cfg, 'aggregator', 'missing')).toEqual(
      orgCapabilities(cfg, 'aggregator'),
    );
    expect(orgCapabilities(cfg, 'aggregator', null)).toEqual(orgCapabilities(cfg, 'aggregator'));
  });
});
