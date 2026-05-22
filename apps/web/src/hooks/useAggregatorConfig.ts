'use client';

/**
 * `useAggregatorConfig` — reads the active deployment's brand + domain
 * config from the BFF, caching for the page session. Sidebar, topbar,
 * dashboard tabs, and (post-refactor) URL routes all read from here so
 * the same web image runs blue_dot / purple_dot / yellow_dot without
 * source changes.
 *
 * Falls back to a minimal Blue Dots default while the network call is
 * in flight so first paint is never blank.
 */

import { useQuery } from '@tanstack/react-query';
import { jsonFetch } from '../services/http';

export interface AggregatorConfigDomain {
  id: string;
  label: string;
  plural_label: string;
  item_type: string;
}

export interface AggregatorConfigPayload {
  aggregator: {
    name: string;
    legal_name?: string;
    contact_email?: string;
  };
  brand: {
    short_name: string;
    long_name: string;
    tagline?: string;
    url_slug: string;
    primary_color?: string;
    accent_color?: string;
    logo_url?: string;
    favicon_url?: string;
  };
  network: {
    id: string;
    display_name?: string;
  };
  domains: AggregatorConfigDomain[];
}

/**
 * Conservative fallback used while the first network call is in flight.
 * Matches the pre-genericisation defaults so existing screens render
 * exactly the same on a cold mount.
 */
export const DEFAULT_AGGREGATOR_CONFIG: AggregatorConfigPayload = {
  aggregator: { name: 'Aggregator' },
  brand: {
    short_name: 'Blue Dots',
    long_name: 'Blue Dots Aggregator Portal',
    tagline: 'Track every participant in your network — at a glance.',
    url_slug: 'dashboard',
    primary_color: '#2563EB',
  },
  network: { id: 'blue_dot' },
  domains: [
    { id: 'seeker', label: 'Seekers', plural_label: 'Seekers', item_type: 'profile_1.0' },
    { id: 'provider', label: 'Providers', plural_label: 'Providers', item_type: 'job_posting_1.0' },
  ],
};

export function useAggregatorConfig() {
  return useQuery({
    queryKey: ['aggregator-config'],
    queryFn: () => jsonFetch<AggregatorConfigPayload>('/api/aggregator-config'),
    // Brand + domains rarely change between deploys; stale data is fine.
    staleTime: 5 * 60 * 1000,
  });
}
