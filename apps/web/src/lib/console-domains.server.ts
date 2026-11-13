/**
 * The network's domains for the console (`apps/web`, user & org Phase 5):
 * ids and labels from the public aggregator config, so a coordinator's
 * served domains read as "Seekers" rather than `seeker`.
 *
 * @module apps/web/src/lib/console-domains.server
 */

import { servedDomainIds } from '@aggregator-dpg/shared-primitives/aggregator';
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
 * The network domains a coordinator serves, with their labels, in network
 * order. Ids the network does not have are left out, as the portal and the API
 * do. When the network's domains could not be read, the stored ids are shown
 * as they are.
 *
 * @param serves - Domain ids served; empty means none.
 * @param domains - From {@link networkDomains}; empty when they could not be read.
 * @returns The served domains.
 */
export function servedDomains(
  serves: readonly string[],
  domains: readonly ConsoleDomain[],
): ConsoleDomain[] {
  if (domains.length === 0) return serves.map((id) => ({ id, label: id }));
  const ids = servedDomainIds(
    serves,
    domains.map((d) => d.id),
  );
  return domains.filter((d) => ids.includes(d.id));
}
