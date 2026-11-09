/**
 * The network's domains for the console (`apps/web`, user & org Phase 5):
 * ids and labels from the public aggregator config, so a coordinator's
 * served domains read as "Seekers" rather than `seeker`.
 *
 * @module apps/web/src/lib/console-domains.server
 */

import { readDomainLabels, type DomainLabel } from './aggregator-config-domains';

/** One network domain. */
export type ConsoleDomain = DomainLabel;

/**
 * Reads the network's domains (server-side; empty on any failure, so a
 * page still renders with domain ids).
 *
 * @returns The domains, in configuration order.
 */
export async function networkDomains(): Promise<ConsoleDomain[]> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${base}/v1/aggregator-config`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    return readDomainLabels(await res.json()) ?? [];
  } catch {
    return [];
  }
}

/**
 * The domains a coordinator serves, with their labels.
 *
 * @param serves - Domain ids served; empty means none.
 * @param domains - From {@link networkDomains}.
 * @returns The served domains (an unknown id keeps its id as the label).
 */
export function servedDomains(
  serves: readonly string[],
  domains: readonly ConsoleDomain[],
): ConsoleDomain[] {
  return serves.map((id) => ({ id, label: domains.find((d) => d.id === id)?.label ?? id }));
}
