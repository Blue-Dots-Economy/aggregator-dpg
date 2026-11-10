'use client';

/**
 * Active participant domain for the signed-in coordinator, in `apps/web`.
 *
 * A coordinator may serve several domains. The dashboard, the sidebar badge,
 * registration links and bulk upload all act on one of them at a time, chosen
 * here so every screen agrees.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useProfileRaw } from './useProfile';
import {
  DEFAULT_AGGREGATOR_CONFIG,
  useAggregatorConfig,
  type AggregatorConfigDomain,
} from './useAggregatorConfig';

/** localStorage key holding the coordinator's last chosen domain. */
export const ACTIVE_DOMAIN_STORAGE_KEY = 'bd:active-domain';

/** The URL query parameter carrying the active domain. */
export const ACTIVE_DOMAIN_PARAM = 'domain';

/** What {@link useActiveDomain} returns. */
export interface ActiveDomainState {
  /** Network domains the coordinator serves, in network order. */
  domains: AggregatorConfigDomain[];
  /** The domain in use; `undefined` until ready or when none is served. */
  active: string | undefined;
  /** Switches domain: sets `?domain=` and stores the choice. */
  setActive: (id: string) => void;
  /** `false` until the profile, the network config and the stored choice are loaded. */
  ready: boolean;
  /**
   * `true` when the profile or the network config failed to load. `domains`
   * is then empty because it is unknown, not because none is served.
   */
  error: boolean;
  /** `true` while a {@link ActiveDomainState.retry} is in flight. */
  retrying: boolean;
  /** Fetches the profile and the network config again. */
  retry: () => void;
}

/**
 * Picks the active domain from the served ones.
 *
 * Order: the URL value, then the stored last choice, then the first served
 * domain. A value the coordinator does not serve is ignored.
 *
 * @param served - Served domain ids, in network order.
 * @param fromUrl - The `?domain=` value, if any.
 * @param stored - The stored last choice, if any.
 * @returns The domain id, or `undefined` when nothing is served.
 */
export function resolveActiveDomain(
  served: readonly string[],
  fromUrl: string | null,
  stored: string | null,
): string | undefined {
  if (fromUrl && served.includes(fromUrl)) return fromUrl;
  if (stored && served.includes(stored)) return stored;
  return served[0];
}

/**
 * The network domains a coordinator serves.
 *
 * An empty `serves` means none: the coordinator can act on no participants.
 *
 * @param serves - The coordinator's stored domain ids.
 * @param networkDomains - The network's domains, in declaration order.
 * @returns The served domains, in network order.
 */
export function servedNetworkDomains(
  serves: readonly string[],
  networkDomains: readonly AggregatorConfigDomain[],
): AggregatorConfigDomain[] {
  return networkDomains.filter((d) => serves.includes(d.id));
}

/**
 * Returns the coordinator's served domains and the one in use.
 *
 * @returns The active-domain state.
 */
export function useActiveDomain(): ActiveDomainState {
  const profile = useProfileRaw();
  const config = useAggregatorConfig();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [stored, setStored] = useState<string | null>(null);
  const [storageRead, setStorageRead] = useState(false);

  // Server markup has no storage; read the stored choice on the client.
  useEffect(() => {
    try {
      setStored(window.localStorage.getItem(ACTIVE_DOMAIN_STORAGE_KEY));
    } catch {
      // Storage may be unavailable; the first served domain is used.
    }
    setStorageRead(true);
  }, []);

  const networkDomains = (config.data ?? DEFAULT_AGGREGATOR_CONFIG).domains;
  const profileData = profile.data;
  const domains = useMemo(() => {
    if (!profileData) return [];
    return servedNetworkDomains(profileData.serves, networkDomains);
  }, [profileData, networkDomains]);

  const profileSettled = profileData !== undefined || profile.isError;
  const ready = profileSettled && !config.isLoading && storageRead;
  const active = ready
    ? resolveActiveDomain(
        domains.map((d) => d.id),
        searchParams.get(ACTIVE_DOMAIN_PARAM),
        stored,
      )
    : undefined;

  const setActive = useCallback(
    (id: string) => {
      try {
        window.localStorage.setItem(ACTIVE_DOMAIN_STORAGE_KEY, id);
      } catch {
        // Storage may be unavailable; the URL still carries the choice.
      }
      setStored(id);
      const params = new URLSearchParams(searchParams.toString());
      params.set(ACTIVE_DOMAIN_PARAM, id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const error = profile.isError || config.isError;
  const retrying = error && (profile.isFetching || config.isFetching);
  const { refetch: refetchProfile } = profile;
  const { refetch: refetchConfig } = config;
  const retry = useCallback(() => {
    void refetchProfile();
    void refetchConfig();
  }, [refetchProfile, refetchConfig]);

  return { domains, active, setActive, ready, error, retrying, retry };
}
