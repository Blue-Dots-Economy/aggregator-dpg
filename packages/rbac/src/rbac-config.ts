/**
 * Schema and lookups for `config/rbac.yaml` (`@aggregator-dpg/rbac`).
 *
 * The file holds the default PermissionSets, which set each `org_type` gets,
 * the capabilities of each role, and the per-user grants. It is validated once
 * at boot: an unknown capability or a broken reference stops the API from
 * starting rather than failing a request later.
 *
 * @module @aggregator-dpg/rbac/rbac-config
 */

import { z } from 'zod';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { CAPABILITIES, CapabilitySchema, OrgTypeSchema, UserTypeSchema } from './interface.js';
import type { Capability, OrgType, UserType } from './interface.js';
import { USER_GRANTABLE } from './catalogue.js';

const CapabilityListSchema = z.array(CapabilitySchema).refine((l) => new Set(l).size === l.length, {
  message: 'duplicate capability',
});

/** Zod schema for the whole `rbac.yaml` document. */
export const RbacConfigSchema = z
  .object({
    version: z.literal(1),
    roles: z.record(UserTypeSchema, CapabilityListSchema),
    grants: z.record(
      z.string().min(1),
      z.object({
        capabilities: CapabilityListSchema,
        max_days: z.number().int().positive(),
      }),
    ),
    permission_sets: z.record(z.string().min(1), CapabilityListSchema),
    org_type_defaults: z.record(OrgTypeSchema, z.string().min(1)),
  })
  .superRefine((cfg, ctx) => {
    for (const ut of UserTypeSchema.options) {
      if (!cfg.roles[ut]) {
        ctx.addIssue({ code: 'custom', path: ['roles', ut], message: 'role missing' });
      }
    }
    for (const ot of OrgTypeSchema.options) {
      const set = cfg.org_type_defaults[ot];
      if (!set) {
        ctx.addIssue({
          code: 'custom',
          path: ['org_type_defaults', ot],
          message: 'default missing',
        });
      } else if (!cfg.permission_sets[set]) {
        ctx.addIssue({
          code: 'custom',
          path: ['org_type_defaults', ot],
          message: `unknown permission set "${set}"`,
        });
      }
    }
    const rootSet = cfg.permission_sets[cfg.org_type_defaults.network_facilitator ?? ''];
    if (rootSet && rootSet.length !== CAPABILITIES.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['permission_sets'],
        message: 'the network_facilitator set must hold every capability',
      });
    }
    for (const [key, grant] of Object.entries(cfg.grants)) {
      if (grant.capabilities.length !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['grants', key],
          message: 'a grant holds exactly one capability',
        });
      }
      for (const cap of grant.capabilities) {
        if (!USER_GRANTABLE.includes(cap)) {
          ctx.addIssue({
            code: 'custom',
            path: ['grants', key],
            message: `"${cap}" cannot be granted per user`,
          });
        }
      }
    }
  });

/** The validated `rbac.yaml` document. */
export type RbacConfig = z.infer<typeof RbacConfigSchema>;

/**
 * Validates a parsed `rbac.yaml` document.
 *
 * @param raw - The parsed YAML.
 * @param source - Where it came from, for the error message.
 * @returns The validated config.
 * @throws {ConfigError} `RBAC_CONFIG_INVALID` with the Zod issues.
 */
export function parseRbacConfig(raw: unknown, source: string): RbacConfig {
  const parsed = RbacConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid rbac config at ${source}`, {
      code: 'RBAC_CONFIG_INVALID',
      details: { source, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

/**
 * Returns a role's capabilities.
 *
 * @param cfg - The validated config.
 * @param userType - The account type.
 * @returns The role's capabilities.
 */
export function roleCapabilities(cfg: RbacConfig, userType: UserType): Capability[] {
  return [...(cfg.roles[userType] ?? [])];
}

/**
 * Returns an organisation's effective PermissionSet.
 *
 * @param cfg - The validated config.
 * @param orgType - The organisation's type.
 * @param override - The organisation's own set name, if it has one.
 * @returns The capabilities of the override set, else of the type's default.
 */
export function orgCapabilities(
  cfg: RbacConfig,
  orgType: OrgType,
  override?: string | null,
): Capability[] {
  const name =
    override && cfg.permission_sets[override] ? override : cfg.org_type_defaults[orgType];
  return [...(cfg.permission_sets[name ?? ''] ?? [])];
}
