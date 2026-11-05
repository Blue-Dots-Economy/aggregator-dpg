'use client';

/**
 * Loads a reference dataset (e.g. the institute list) for a form widget (web app).
 *
 * Datasets are static JSON files outside this repo, served from
 * `REFERENCE_BASE_URL` or the app's own `/reference/` path. Each loads once per
 * page and is shared by every field that uses it.
 *
 * @module apps/web/hooks/useReferenceDataset
 */

import { useQuery } from '@tanstack/react-query';

/** Where reference datasets are served from when no override is configured. */
const DEFAULT_REFERENCE_BASE = '/reference/';

/** One shared empty list, so the widget's memoised suggestions keep their identity. */
const EMPTY: never[] = [];

/**
 * Builds the URL a dataset is fetched from.
 *
 * A relative base resolves against the app origin. A remote host must allow
 * CORS, since the browser fetches it directly. A blank base counts as unset.
 *
 * @param id - Resolved dataset file id, without `.json`.
 * @param referenceBaseUrl - Optional base URL override.
 * @returns An absolute URL to the dataset JSON.
 */
function referenceUrl(id: string, referenceBaseUrl?: string): string {
  const raw = referenceBaseUrl?.trim() || DEFAULT_REFERENCE_BASE;
  const base = raw.endsWith('/') ? raw : `${raw}/`;
  return new URL(`${id}.json`, new URL(base, window.location.origin)).toString();
}

/**
 * Fetches one dataset and parses it.
 *
 * Uses a plain `fetch` with no cookies or JSON headers, so a public host that
 * answers `access-control-allow-origin: *` serves it without a preflight.
 *
 * @throws {Error} When the response is not OK or the body is not JSON.
 */
async function fetchDataset<T>(
  url: string,
  parse: (raw: unknown) => T[],
  signal: AbortSignal,
): Promise<T[]> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`reference dataset ${url} → ${res.status}`);
    return parse(await res.json());
  } catch (err) {
    if (!signal.aborted) {
      console.warn('[reference-dataset] load failed; the field works as plain text', {
        operation: 'reference-dataset.fetch',
        status: 'failure',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
}

/**
 * Returns a dataset's options, or `[]` while it loads, after a failed load, or
 * when `id` is `null`.
 *
 * @param id - Resolved dataset file id, or `null` for a field with no source.
 * @param referenceBaseUrl - Optional base URL override from the form runtime config.
 * @param parse - Turns the parsed JSON into options.
 * @returns The options to search.
 */
export function useReferenceDataset<T>(
  id: string | null,
  referenceBaseUrl: string | undefined,
  parse: (raw: unknown) => T[],
): T[] {
  const { data } = useQuery({
    queryKey: ['reference-dataset', id, referenceBaseUrl ?? ''],
    queryFn: ({ signal }) => fetchDataset(referenceUrl(id ?? '', referenceBaseUrl), parse, signal),
    enabled: id !== null,
    // A dataset only changes with a deployment, so it loads once per page.
    staleTime: Infinity,
    gcTime: Infinity,
    // A missing dataset stays missing; the field works as plain text.
    retry: false,
  });
  return data ?? EMPTY;
}
