/**
 * Keycloak service-account token client.
 *
 * Some BFF routes proxy upstream calls on behalf of an anonymous browser
 * (e.g. POST /api/aggregator/register). The aggregator API requires a
 * Bearer token on every endpoint, so the BFF authenticates to Keycloak
 * with the `aggregator-bff` confidential client (client_credentials grant)
 * and attaches the resulting service-account access token to those calls.
 *
 * Tokens are cached in-process until ~30s before expiry to avoid one
 * round-trip per upstream call.
 */

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

import { positiveIntEnv } from './env';

/** Refresh the cached service token this many ms before expiry (`SERVICE_TOKEN_REFRESH_LEAD_MS`). */
const REFRESH_LEAD_MS = positiveIntEnv('SERVICE_TOKEN_REFRESH_LEAD_MS', 30_000);

let cached: CachedToken | null = null;

interface ServiceTokenConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

function readConfig(): ServiceTokenConfig {
  const issuer = mustEnv('OIDC_ISSUER').replace(/\/+$/, '');
  return {
    tokenUrl: `${issuer}/protocol/openid-connect/token`,
    clientId: mustEnv('BFF_SERVICE_CLIENT_ID'),
    clientSecret: mustEnv('BFF_SERVICE_CLIENT_SECRET'),
  };
}

/**
 * Returns a fresh service-account access token, fetching one if the cached
 * value is missing or near expiry.
 */
export async function getServiceAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - REFRESH_LEAD_MS) {
    return cached.accessToken;
  }
  const cfg = readConfig();
  const params = new URLSearchParams();
  params.set('grant_type', 'client_credentials');
  params.set('client_id', cfg.clientId);
  params.set('client_secret', cfg.clientSecret);

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(positiveIntEnv('WEB_OIDC_TIMEOUT_MS', 10_000)),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`service-token HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  return cached.accessToken;
}

/** Test helper — clear the cache. */
export function _resetServiceToken(): void {
  cached = null;
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}
