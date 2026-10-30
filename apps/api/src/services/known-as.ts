/**
 * "Known as" values and tree rules (`@aggregator-dpg/api`).
 *
 * The built-in system value `aggregator` is allowed at every depth and is the
 * fallback for new orgs. Instance values may be limited to some depths.
 */

import {
  SYSTEM_KNOWN_AS,
  type KnownAsConfig,
  type OrganisationConfig,
} from '@aggregator-dpg/network-config/interface';
import type { TreeRules } from './organisation-store/interface.js';

/** One "known as" value; `depths` is `null` when the value is allowed at any depth. */
export interface KnownAsEntry {
  key: string;
  name: string;
  depths: number[] | null;
  /** True for the built-in `aggregator` value. */
  system: boolean;
}

/**
 * Every "known as" value.
 *
 * @param cfg - The instance's `organisation.known_as` config.
 * @returns The system value first, then the instance values in config order.
 */
export function knownAsValues(cfg: KnownAsConfig): KnownAsEntry[] {
  return [
    { ...SYSTEM_KNOWN_AS, depths: null, system: true },
    ...cfg.values.map((v) => ({
      key: v.key,
      name: v.name,
      depths: v.depths ?? null,
      system: false,
    })),
  ];
}

/**
 * The name of a value.
 *
 * @param cfg - The config.
 * @param key - A value key.
 * @returns The name, or `null` for a key that is not configured.
 */
export function nameOf(cfg: KnownAsConfig, key: string): string | null {
  if (key === SYSTEM_KNOWN_AS.key) return SYSTEM_KNOWN_AS.name;
  return cfg.values.find((v) => v.key === key)?.name ?? null;
}

/**
 * Whether a value may be used at a depth.
 *
 * @param cfg - The config.
 * @param key - A value key.
 * @param depth - The org's depth; 1 is directly under the network.
 * @returns True for the system value, and for an instance value with no `depths` or listing `depth`.
 */
export function isAllowedAt(cfg: KnownAsConfig, key: string, depth: number): boolean {
  if (key === SYSTEM_KNOWN_AS.key) return true;
  const v = cfg.values.find((x) => x.key === key);
  if (!v) return false;
  return !v.depths || v.depths.includes(depth);
}

/**
 * The value a new org gets at a depth.
 *
 * @param cfg - The config.
 * @param depth - The new org's depth.
 * @returns The `suggest` key for that depth, else the system value.
 */
export function suggestFor(cfg: KnownAsConfig, depth: number): string {
  return cfg.suggest.find((s) => s.depth === depth)?.key ?? SYSTEM_KNOWN_AS.key;
}

/**
 * The store's tree rules for the instance.
 *
 * @param org - The instance's `organisation` config.
 * @returns Limits and "known as" checks; `maxChildren` is `null` when unset.
 */
export function treeRules(org: OrganisationConfig): TreeRules {
  return {
    maxDepth: org.hierarchy.max_depth,
    maxChildren: org.hierarchy.max_children ?? null,
    maxTotalOrgs: org.hierarchy.max_total_orgs,
    knownAsAllowed: (key, depth) => isAllowedAt(org.known_as, key, depth),
    knownAsConfigured: (key) =>
      key === SYSTEM_KNOWN_AS.key || org.known_as.values.some((v) => v.key === key),
    suggestFor: (depth) => suggestFor(org.known_as, depth),
  };
}
