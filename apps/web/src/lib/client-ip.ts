/**
 * Works out the caller's IP for the public BFF proxies, which pass it to the
 * API so the API can rate-limit per caller.
 *
 * Each proxy in front of the web app appends the address it received the
 * request from to `X-Forwarded-For`. Only those right-most entries are
 * trustworthy; anything to their left came from the caller and may be made up.
 *
 * @module apps/web/src/lib/client-ip
 */

import { isIP } from 'node:net';

/**
 * Default number of trusted proxies in front of the web app: one ingress
 * (Kong in the cluster, nginx in the local stack) that appends the caller's
 * address to `X-Forwarded-For`.
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

/**
 * Reads the trusted-proxy count from `TRUSTED_PROXY_HOPS`.
 *
 * `0` means nothing trusted sits in front of the web app, so no IP is
 * forwarded. An empty or invalid value falls back to the default.
 *
 * @param env - The environment to read; defaults to `process.env`.
 * @returns A whole number of hops, `0` or more.
 */
export function resolveTrustedProxyHops(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return DEFAULT_TRUSTED_PROXY_HOPS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_TRUSTED_PROXY_HOPS;
}

/** The value as an IP address, or `undefined` when it is not one. */
function asIp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && isIP(trimmed) !== 0 ? trimmed : undefined;
}

/**
 * Returns the caller's IP as seen by the outermost trusted proxy.
 *
 * Takes the entry `hops` places from the right of `X-Forwarded-For`; entries
 * further left are ignored. A chain shorter than `hops` did not pass through
 * the expected proxies, so nothing is returned. With no `X-Forwarded-For` at
 * all, `X-Real-IP` (which the ingress sets to the caller's address) is used.
 *
 * @param headers - The incoming request headers.
 * @param hops - Number of trusted proxies; defaults to {@link resolveTrustedProxyHops}.
 * @returns The caller's IP, or `undefined` when it cannot be trusted.
 */
export function clientIp(
  headers: Headers,
  hops: number = resolveTrustedProxyHops(),
): string | undefined {
  if (hops < 1) return undefined;
  const xff = headers.get('x-forwarded-for');
  if (xff === null || xff.trim() === '') return asIp(headers.get('x-real-ip') ?? undefined);
  const chain = xff.split(',');
  if (chain.length < hops) return undefined;
  return asIp(chain[chain.length - hops]);
}

/**
 * Headers that pass the caller's IP to the API: a single-entry
 * `x-forwarded-for`, or nothing when no trusted IP is known.
 *
 * @param headers - The incoming request headers.
 * @returns An object to spread into the upstream request headers.
 */
export function forwardedForHeader(headers: Headers): Record<string, string> {
  const ip = clientIp(headers);
  return ip ? { 'x-forwarded-for': ip } : {};
}
