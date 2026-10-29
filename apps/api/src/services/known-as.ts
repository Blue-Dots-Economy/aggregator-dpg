/**
 * "Known as" values and their hierarchy levels (`@aggregator-dpg/api`).
 *
 * Each value in the instance config carries a level: 1 sits directly under
 * the network, 2 under a level-1 org, and so on. An org's level is the level
 * of its `known_as` value; the network is level 0.
 */

import type { KnownAsConfig } from '@aggregator-dpg/network-config/interface';

/** The network facilitator's level. */
export const NETWORK_LEVEL = 0;

/**
 * The level of a value.
 *
 * @param cfg - The instance's `organisation.known_as` config.
 * @param key - A value key.
 * @returns The level, or `null` for a key that is not configured.
 */
export function levelOf(cfg: KnownAsConfig, key: string): number | null {
  return cfg.values.find((v) => v.key === key)?.level ?? null;
}

/**
 * The label of a value.
 *
 * @param cfg - The config.
 * @param key - A value key.
 * @returns The label, or `null` for a key that is not configured.
 */
export function labelOf(cfg: KnownAsConfig, key: string): string | null {
  return cfg.values.find((v) => v.key === key)?.label ?? null;
}

/**
 * The value a new org gets under a parent: the only value one level below
 * the parent, else the config default.
 *
 * @param cfg - The config.
 * @param parentLevel - The parent's level; 0 for the network, `null` when unknown.
 * @returns The value key.
 */
export function childKnownAs(cfg: KnownAsConfig, parentLevel: number | null): string {
  if (parentLevel === null) return cfg.default;
  const below = cfg.values.filter((v) => v.level === parentLevel + 1);
  return below.length === 1 ? below[0]!.key : cfg.default;
}

/**
 * The configured levels in order, each with its values.
 *
 * @param cfg - The config.
 * @returns Level 1 first; every level has at least one value.
 */
export function levelsOf(
  cfg: KnownAsConfig,
): Array<{ level: number; values: Array<{ key: string; label: string }> }> {
  const top = Math.max(...cfg.values.map((v) => v.level));
  return Array.from({ length: top }, (_, i) => ({
    level: i + 1,
    values: cfg.values
      .filter((v) => v.level === i + 1)
      .map((v) => ({ key: v.key, label: v.label })),
  }));
}
