/**
 * Keycloak client-credentials token provider for signals' service-auth
 * bearer path (Phase C of the aggregator-keycloak-integration plan).
 *
 * Mirrors `apps/web/src/lib/service-token.ts` (in-process cache, ~30s
 * refresh lead) but is shared here so both `apps/api` and `apps/worker` — the
 * two processes that construct {@link HttpSignalStackWriter} — get the same
 * implementation instead of duplicating the client-credentials grant.
 */

import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { SignalStackTokenProviderBase } from './interface.js';

const REFRESH_LEAD_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface KeycloakTokenProviderConfig {
  /** Keycloak base URL, e.g. `http://keycloak:8080`. No trailing slash. */
  baseUrl: string;
  /** Realm holding the service client (the combined realm both DPGs share). */
  realm: string;
  /** Confidential client id — must equal `aggregator-dpg` (signals maps client id → organization.slug). */
  clientId: string;
  clientSecret: string;
  /** Optional override; defaults to global `fetch`. Lets tests inject a stub. */
  fetchImpl?: typeof fetch;
  /** Per-attempt request timeout in ms. Default 10s. */
  timeoutMs?: number;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export class KeycloakClientCredentialsTokenProvider extends SignalStackTokenProviderBase {
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private cached: CachedToken | null = null;

  constructor(config: KeycloakTokenProviderConfig) {
    super();
    if (!config.baseUrl) throw new Error('KeycloakClientCredentialsTokenProvider requires baseUrl');
    if (!config.realm) throw new Error('KeycloakClientCredentialsTokenProvider requires realm');
    if (!config.clientId)
      throw new Error('KeycloakClientCredentialsTokenProvider requires clientId');
    if (!config.clientSecret) {
      throw new Error('KeycloakClientCredentialsTokenProvider requires clientSecret');
    }
    const base = config.baseUrl.replace(/\/+$/, '');
    this.tokenUrl = `${base}/realms/${config.realm}/protocol/openid-connect/token`;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  override async getToken(): Promise<Result<string, BaseError>> {
    if (this.cached && Date.now() < this.cached.expiresAt - REFRESH_LEAD_MS) {
      return ok(this.cached.accessToken);
    }

    const params = new URLSearchParams();
    params.set('grant_type', 'client_credentials');
    params.set('client_id', this.clientId);
    params.set('client_secret', this.clientSecret);

    try {
      const res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // A 503 here means Keycloak itself was unreachable when signals (or,
        // here, us minting our own token) tried to talk to it — the
        // credential was never judged. Distinguish from a genuine bad
        // client id/secret (4xx) so callers don't treat it as an auth
        // failure requiring different credentials.
        const code =
          res.status >= 500 ? 'IDENTITY_PROVIDER_UNAVAILABLE' : 'SIGNALSTACK_AUTH_FAILED';
        return err(
          new UpstreamError(`signalstack token grant returned ${res.status}`, {
            code,
            details: { status: res.status, body: text.slice(0, 500) },
          }),
        );
      }

      const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
        return err(
          new UpstreamError('signalstack token grant returned an unexpected payload', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
          }),
        );
      }
      this.cached = {
        accessToken: body.access_token,
        expiresAt: Date.now() + body.expires_in * 1000,
      };
      return ok(this.cached.accessToken);
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack token grant timed out after ${this.timeoutMs}ms`
            : `signalstack token grant transport failure: ${cause.message}`,
          { cause, code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED' },
        ),
      );
    }
  }

  /** Test helper — force the next `getToken()` call to bypass the cache. */
  _resetCache(): void {
    this.cached = null;
  }
}
