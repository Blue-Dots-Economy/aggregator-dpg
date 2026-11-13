/**
 * Keycloak client-credentials token provider for bearer auth to Signals.
 *
 * Part of the signalstack-writer package. Used by `apps/api` and
 * `apps/worker` when they build {@link HttpSignalStackWriter}. Tokens are
 * cached in process and refreshed about 30s before expiry.
 */

import { z } from 'zod';
import { UpstreamError, toError } from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { SignalStackTokenProviderBase } from './interface.js';
import { readJsonBody, responseIssues } from './signals-responses.js';
import { isTimeout } from './thrown.js';

const REFRESH_LEAD_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface KeycloakTokenProviderConfig {
  /** Keycloak base URL, e.g. `http://keycloak:8080`. No trailing slash. */
  baseUrl: string;
  /** Realm holding the service client. */
  realm: string;
  /**
   * Confidential client id. Must equal the aggregator's Signals
   * `organization.slug`; callers check this at boot.
   */
  clientId: string;
  clientSecret: string;
  /** Optional fetch override; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-attempt request timeout in ms. Default 10s. */
  timeoutMs?: number;
}

/** The fields of the OAuth token response that the provider reads. */
const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});

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
  /**
   * The running token request, shared by concurrent callers so only one grant
   * is sent at a time. Cleared when it settles, so a failure is not cached.
   */
  private inFlight: Promise<Result<string, BaseError>> | null = null;

  constructor(config: KeycloakTokenProviderConfig) {
    super();
    if (!config.baseUrl) throw new Error('KeycloakClientCredentialsTokenProvider requires baseUrl');
    if (!config.realm) throw new Error('KeycloakClientCredentialsTokenProvider requires realm');
    if (!config.clientId)
      throw new Error('KeycloakClientCredentialsTokenProvider requires clientId');
    if (!config.clientSecret) {
      throw new Error('KeycloakClientCredentialsTokenProvider requires clientSecret');
    }
    let base = config.baseUrl;
    while (base.endsWith('/')) base = base.slice(0, -1);
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
    // Join an already-running mint instead of starting a second grant.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this._mint().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Discards the cached token so the next {@link getToken} call fetches a new one.
   *
   * Called by {@link HttpSignalStackWriter} when signals rejects a token with
   * 401, for example after a realm key rotation.
   */
  override invalidate(): void {
    this.cached = null;
  }

  /** Performs one client-credentials grant. Callers go through {@link getToken}. */
  private async _mint(): Promise<Result<string, BaseError>> {
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
        // 5xx means Keycloak was unavailable, not that the credentials are wrong.
        const code =
          res.status >= 500 ? 'IDENTITY_PROVIDER_UNAVAILABLE' : 'SIGNALSTACK_AUTH_FAILED';
        return err(
          new UpstreamError(`signalstack token grant returned ${res.status}`, {
            code,
            details: { status: res.status, body: text.slice(0, 500) },
          }),
        );
      }

      const json = await readJsonBody(res, 'signalstack token grant');
      if (!json.success) return json;
      const parsed = TokenResponseSchema.safeParse(json.value);
      if (!parsed.success) {
        // Paths and codes only: the body can carry the access token.
        return err(
          new UpstreamError('signalstack token grant returned an unexpected payload', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { issues: responseIssues(parsed.error) },
          }),
        );
      }
      this.cached = {
        accessToken: parsed.data.access_token,
        expiresAt: Date.now() + parsed.data.expires_in * 1000,
      };
      return ok(this.cached.accessToken);
    } catch (e) {
      const cause = toError(e);
      const timedOut = isTimeout(e);
      return err(
        new UpstreamError(
          timedOut
            ? `signalstack token grant timed out after ${this.timeoutMs}ms`
            : `signalstack token grant transport failure: ${cause.message}`,
          { cause, code: timedOut ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED' },
        ),
      );
    }
  }

  /** Test helper. Makes the next `getToken()` call skip the cache. */
  _resetCache(): void {
    this.cached = null;
  }
}
