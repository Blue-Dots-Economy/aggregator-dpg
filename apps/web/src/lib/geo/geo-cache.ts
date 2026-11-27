/**
 * Session cache for geo lookups. Same as Signals-DPG `apps/ui/src/lib/geo/geo-cache.ts`.
 *
 * @module apps/web/lib/geo/geo-cache
 */
import type { GeoProvider, GeoSuggestion } from './types';

/** Default LRU cap for a memoized geo lookup (entries). */
const DEFAULT_CACHE_CAP = 500;

/**
 * Normalises a place query (trim, lowercase, single spaces) for use as a cache key.
 *
 * @param query - The raw query.
 * @returns The normalised key.
 */
export function normalizeGeoKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Calls `fn` at once and returns its result as a promise, so a synchronous
 * throw arrives as a rejection.
 */
async function callNow<T>(
  fn: (query: string, signal?: AbortSignal) => Promise<T>,
  query: string,
  signal: AbortSignal,
): Promise<T> {
  return fn(query, signal);
}

/**
 * Runs `cleanup` once `promise` settles, and never rejects.
 *
 * The lookup's caller receives any rejection; this side task must not raise a
 * second, unhandled one.
 */
async function afterSettled(promise: Promise<unknown>, cleanup: () => void): Promise<void> {
  try {
    await promise;
  } catch {
    // The caller of the lookup handles the error.
  } finally {
    cleanup();
  }
}

/**
 * Wraps an async geo lookup with a session LRU cache and in-flight dedup.
 *
 * Only results where `shouldCache(value)` is true are stored. The shared call
 * is aborted only when every waiting caller has aborted.
 *
 * @param fn - The lookup to wrap.
 * @param shouldCache - Whether a result may be cached.
 * @param cap - Maximum cache entries.
 * @returns The memoised lookup.
 */
export function memoizeGeoLookup<T>(
  fn: (query: string, signal?: AbortSignal) => Promise<T>,
  shouldCache: (value: T) => boolean,
  cap: number = DEFAULT_CACHE_CAP,
): (query: string, signal?: AbortSignal) => Promise<T> {
  const resolved = new Map<string, T>();

  interface InFlight {
    promise: Promise<T>;
    controller: AbortController;
    waiters: Set<object>;
  }
  const inFlight = new Map<string, InFlight>();

  /** Runs one lookup, stores a cacheable result, and clears its in-flight entry. */
  async function lookup(key: string, query: string, signal: AbortSignal): Promise<T> {
    try {
      // `callNow` turns a synchronous throw into a rejection, so the `finally`
      // below runs after the caller has stored this entry and removes it.
      const value = await callNow(fn, query, signal);
      if (shouldCache(value)) {
        resolved.set(key, value);
        if (resolved.size > cap) {
          const oldest = resolved.keys().next();
          if (!oldest.done) resolved.delete(oldest.value);
        }
      }
      return value;
    } finally {
      inFlight.delete(key);
    }
  }

  return (query: string, signal?: AbortSignal): Promise<T> => {
    const key = normalizeGeoKey(query);

    if (resolved.has(key)) {
      const value = resolved.get(key)!;
      resolved.delete(key); // refresh LRU recency
      resolved.set(key, value);
      return Promise.resolve(value);
    }

    let entry = inFlight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: InFlight = {
        controller,
        waiters: new Set<object>(),
        promise: lookup(key, query, controller.signal),
      };
      inFlight.set(key, created);
      entry = created;
    }

    // Abort the shared fetch only when every waiter has aborted.
    const current = entry;
    const token = {};
    current.waiters.add(token);

    if (signal) {
      const onAbort = () => {
        current.waiters.delete(token);
        if (current.waiters.size === 0) current.controller.abort();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        void afterSettled(current.promise, () => signal.removeEventListener('abort', onAbort));
      }
    }
    void afterSettled(current.promise, () => {
      current.waiters.delete(token);
    });

    return current.promise;
  };
}

/**
 * Wraps a GeoProvider so `suggest` results are session-cached when non-empty.
 *
 * @param base - The provider to wrap.
 * @returns The cached provider.
 */
export function withGeoCache(base: GeoProvider): GeoProvider {
  const cachedSuggest = memoizeGeoLookup<GeoSuggestion[]>(
    (q, signal) => base.suggest(q, signal),
    (results) => results.length > 0,
  );
  return { suggest: cachedSuggest };
}
