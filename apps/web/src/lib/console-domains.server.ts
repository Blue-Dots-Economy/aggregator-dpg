/**
 * The network's domains for the console (`apps/web`, user & org Phase 5):
 * ids and labels from the public aggregator config, so a coordinator's
 * served domains read as "Seekers" rather than `seeker`.
 *
 * @module apps/web/src/lib/console-domains.server
 */

/** One network domain. */
export interface ConsoleDomain {
  id: string;
  label: string;
}

interface ConfigPayload {
  network?: { id?: string };
  domains?: ConsoleDomain[];
}

/** The network id and its domains. */
export interface ConsoleNetwork {
  /** The network id, e.g. `blue_dot`, or null when unknown. */
  id: string | null;
  domains: ConsoleDomain[];
}

/**
 * Reads the network id and domains (server-side; empty on any failure, so a
 * page still renders with domain ids).
 *
 * @returns The network id and its domains, in configuration order.
 */
export async function consoleNetwork(): Promise<ConsoleNetwork> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${base}/v1/aggregator-config`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { id: null, domains: [] };
    const cfg = (await res.json()) as ConfigPayload;
    return {
      id: cfg.network?.id ?? null,
      domains: (cfg.domains ?? []).map((d) => ({ id: d.id, label: d.label })),
    };
  } catch {
    return { id: null, domains: [] };
  }
}

/**
 * Reads the network's domains (server-side; empty on any failure, so a
 * page still renders with domain ids).
 *
 * @returns The domains, in configuration order.
 */
export async function networkDomains(): Promise<ConsoleDomain[]> {
  return (await consoleNetwork()).domains;
}

/**
 * Labels for a coordinator's served domains.
 *
 * @param serves - Domain ids served; empty means every domain.
 * @param domains - From {@link networkDomains}.
 * @returns The labels (an unknown id shows as-is); every domain's label when `serves` is empty.
 */
export function servedLabels(
  serves: readonly string[],
  domains: readonly ConsoleDomain[],
): string[] {
  if (serves.length === 0) return domains.map((d) => d.label);
  return serves.map((id) => domains.find((d) => d.id === id)?.label ?? id);
}
