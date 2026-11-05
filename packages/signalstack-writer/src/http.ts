/**
 * Fetch-based SignalStackWriter used in production, in the signalstack-writer package.
 *
 * Any non-2xx response, network failure, or unexpected payload becomes an
 * UpstreamError. Methods never throw.
 *
 * Every request goes through {@link HttpSignalStackWriter.requestWithRetry},
 * which applies the per-attempt timeout and retries transport errors,
 * timeouts, `429`, and `5xx` with exponential backoff. Probe, aggregator
 * upsert, and the reads are idempotent. `onboard` is not: each call inserts a
 * new profile, so a retry after a request that did succeed can create a
 * duplicate (limited by the per-user cap).
 */

import type { z } from 'zod';
import {
  AuthError,
  UpstreamError,
  ValidationError,
  toError,
} from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { stripTrailingSlashes } from '@aggregator-dpg/shared-primitives/url';

import {
  SignalStackWriterBase,
  type SignalStackTokenProviderBase,
  type SignalStackAggregator,
  type SignalStackDashboardExport,
  type SignalStackDashboardExportQuery,
  type SignalStackDashboardPage,
  type SignalStackDashboardQuery,
  type SignalStackDecryptedProfiles,
  type SignalStackFetchDecryptedProfilesQuery,
  type SignalStackOnboardParticipantInput,
  type SignalStackOnboardParticipantResult,
  type SignalStackProbeUserInput,
  type SignalStackProbeUserResult,
  type SignalStackUpsertAggregatorInput,
} from './interface.js';
import {
  DashboardResponseSchema,
  DecryptProfilesResponseSchema,
  ChosenItemSchema,
  ItemIdentitySchema,
  OnboardResponseSchema,
  ProbeUserResponseSchema,
  UpsertAggregatorResponseSchema,
  readJsonBody,
  responseIssues,
} from './signals-responses.js';
import { isTimeout } from './thrown.js';

export interface HttpSignalStackWriterConfig {
  /** Base URL of the signalstack API, e.g. `http://localhost:2743`. No trailing slash. */
  baseUrl: string;
  /**
   * Admin API key issued by signalstack. Sent as `x-api-key`.
   * Set exactly one of this or {@link tokenProvider}.
   */
  apiKey?: string;
  /**
   * Client-credentials token provider. When set, requests send
   * `Authorization: Bearer <token>` instead of `x-api-key`.
   * Set exactly one of this or {@link apiKey}.
   */
  tokenProvider?: SignalStackTokenProviderBase;
  /**
   * Platform-wide signalstack organisation id, sent as `x-acting-org-id` on
   * `POST /api/v1/admin/aggregator/upsert`. Required for that call only.
   */
  actingOrgId?: string;
  /** Optional fetch override; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Optional per-attempt request timeout in ms; off by default. */
  timeoutMs?: number;
  /**
   * Max retries for transport errors, timeouts, `429`, and `5xx`. Default `2`
   * (3 attempts in total). `0` disables retries. Other `4xx` are never retried.
   */
  maxRetries?: number;
  /**
   * Base backoff in ms between retries; doubles each attempt. Default `200`.
   * `0` removes the delay.
   */
  retryBaseMs?: number;
}

/** How requests authenticate to Signals: an admin API key or a bearer token. */
type SignalStackAuth =
  | { kind: 'apikey'; apiKey: string }
  | { kind: 'bearer'; tokenProvider: SignalStackTokenProviderBase };

/** Fetch init with headers as a plain record, so the 401 retry can replace one header. */
type SignalStackRequestInit = Omit<RequestInit, 'headers'> & { headers: Record<string, string> };

/** Default retry count: three attempts in total ride out a brief Signals restart. */
const DEFAULT_MAX_RETRIES = 2;

/** Default first backoff in ms; it doubles per retry, so the default waits 200 + 400 ms. */
const DEFAULT_RETRY_BASE_MS = 200;

/** Longest status filter kept in the export filename; longer than any Signals status. */
const MAX_FILENAME_STATUS_CHARS = 32;

export class HttpSignalStackWriter extends SignalStackWriterBase {
  private readonly baseUrl: string;
  private readonly endpoint: string;
  private readonly auth: SignalStackAuth;
  /**
   * Signalstack organisation id sent as `x-acting-org-id` on the aggregator
   * upsert call. When unset, the upsert returns `SIGNALSTACK_CONFIG_MISSING`.
   */
  private readonly actingOrgId: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(config: HttpSignalStackWriterConfig) {
    super();
    if (!config.baseUrl) {
      throw new Error('HttpSignalStackWriter requires baseUrl');
    }
    if (config.apiKey && config.tokenProvider) {
      throw new Error(
        'HttpSignalStackWriter accepts only one of apiKey or tokenProvider, not both',
      );
    }
    if (config.tokenProvider) {
      this.auth = { kind: 'bearer', tokenProvider: config.tokenProvider };
    } else if (config.apiKey) {
      this.auth = { kind: 'apikey', apiKey: config.apiKey };
    } else {
      throw new Error('HttpSignalStackWriter requires either apiKey or tokenProvider');
    }
    this.baseUrl = stripTrailingSlashes(config.baseUrl);
    this.endpoint = `${this.baseUrl}/api/v1/admin/participant`;
    this.actingOrgId = config.actingOrgId;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  }

  /**
   * Fetches with a per-attempt timeout and exponential-backoff retry.
   *
   * Retries transport errors, timeouts, `429`, and `5xx`. Other `4xx` are
   * returned at once. When retries run out, the last error is re-thrown or the
   * last `Response` is returned.
   *
   * With a token provider, a `401` gets one extra attempt with a new token.
   * This attempt does not use the retry budget and has no backoff. The
   * `x-api-key` path has no such retry.
   *
   * @param url - Absolute request URL.
   * @param init - Fetch init; the `signal` is supplied per attempt.
   * @returns The final `Response` (success, non-retryable, or exhausted).
   * @throws The last transport/timeout error when every attempt threw.
   */
  private async requestWithRetry(url: string, init: SignalStackRequestInit): Promise<Response> {
    let currentInit = init;
    let remintDone = false;
    // Counts retries only; the 401 token refresh does not use the budget.
    let attempt = 0;
    for (;;) {
      const controller = this.timeoutMs ? new AbortController() : undefined;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
      try {
        const res = await this.fetchImpl(url, {
          ...currentInit,
          ...(controller ? { signal: controller.signal } : {}),
        });

        if (res.status === 401 && this.auth.kind === 'bearer' && !remintDone) {
          remintDone = true;
          this.auth.tokenProvider.invalidate();
          const refreshed = await this.auth.tokenProvider.getToken();
          // If the refresh fails, return the original 401 (SIGNALSTACK_FORBIDDEN).
          if (refreshed.success) {
            currentInit = {
              ...currentInit,
              headers: { ...currentInit.headers, authorization: `Bearer ${refreshed.value}` },
            };
            continue;
          }
          return res;
        }

        if (attempt < this.maxRetries && (res.status === 429 || res.status >= 500)) {
          await this.backoff(attempt);
          attempt += 1;
          continue;
        }
        return res;
      } catch (e) {
        if (attempt < this.maxRetries) {
          await this.backoff(attempt);
          attempt += 1;
          continue;
        }
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    // Unreachable: the loop always returns or throws.
  }

  /** Sleeps for `retryBaseMs * 2^attempt` ms before the next retry. */
  private backoff(attempt: number): Promise<void> {
    const ms = this.retryBaseMs * 2 ** attempt;
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Builds the auth and content-type headers for a request.
   *
   * Uses `Authorization: Bearer <token>` when a
   * {@link SignalStackTokenProviderBase} is set, else `x-api-key`. The token is
   * requested on every call; the provider handles caching. Retries reuse the
   * same headers.
   *
   * @returns ok(headers), or the token provider's error.
   */
  private async buildHeaders(): Promise<Result<Record<string, string>, BaseError>> {
    if (this.auth.kind === 'bearer') {
      const tokenResult = await this.auth.tokenProvider.getToken();
      if (!tokenResult.success) return err(tokenResult.error);
      return ok({
        'content-type': 'application/json',
        authorization: `Bearer ${tokenResult.value}`,
      });
    }
    return ok({
      'content-type': 'application/json',
      'x-api-key': this.auth.apiKey,
    });
  }

  override async onboard(
    input: SignalStackOnboardParticipantInput,
  ): Promise<Result<SignalStackOnboardParticipantResult, BaseError>> {
    const guardErr = this.guardInput(input);
    if (guardErr) return err(guardErr);

    const submitMode: 'with_item' | 'account_only' = input.submit_mode ?? 'with_item';
    const body: Record<string, unknown> = {
      name: input.name,
      channel: input.channel,
      source_id: input.source_id,
      network: input.network,
      domain: input.domain,
      item_type: input.item_type,
    };
    // Consent goes only in `compliance`; `terms_accepted`/`privacy_accepted` are never sent.
    if (input.compliance && input.compliance.length > 0) body.compliance = input.compliance;
    if (typeof input.age === 'number') body.age = input.age;
    // `profile` is sent as `item_state`. For account_only it is omitted, so
    // signals creates only the user row.
    if (submitMode !== 'account_only') {
      body.item_state = input.profile;
      // Omitted when empty so signalstack geocodes the address in item_state.
      if (input.item_locations && input.item_locations.length > 0) {
        body.item_locations = input.item_locations;
      }
    }
    // Omit empty email/phone; signalstack rejects null for these fields with 400.
    if (input.phoneNumber) body.phone_number = input.phoneNumber;
    if (input.email) body.email = input.email;

    const headersResult = await this.buildHeaders();
    if (!headersResult.success) return err(headersResult.error);
    const headers = {
      ...headersResult.value,
      'x-acting-org-id': input.actingOrgId,
      ...(input.requestId ? { 'x-request-id': input.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        const upstreamCode = extractUpstreamCode(bodyText);
        // Include signalstack's message when present; callers show it in errors.csv.
        const message = upstreamMsg
          ? `signalstack onboard returned ${res.status}: ${upstreamMsg}`
          : `signalstack onboard returned ${res.status}`;
        // Give the per-user profile cap (409) and an out-of-country coordinate
        // (400) their own codes so callers treat them as data errors.
        const code = this.onboardErrorCode(res.status, upstreamCode);
        // `signalsMessage` is safe to show end users; `message` is for operators.
        const signalsMessage = extractUpstreamMessageText(bodyText);
        // Signals' per-field errors, so callers can point at the bad input.
        const signalsFields = extractUpstreamFields(bodyText);
        return err(
          new UpstreamError(message, {
            code,
            details: {
              status: res.status,
              ...(signalsMessage ? { signalsMessage } : {}),
              ...(upstreamCode ? { upstreamCode } : {}),
              ...(signalsFields ? { signalsFields } : {}),
            },
          }),
        );
      }

      const json = await readJsonBody(res, 'signalstack onboard');
      if (!json.success) return json;
      const parsed = OnboardResponseSchema.safeParse(json.value);
      if (!parsed.success) return err(badResponseError('onboard', parsed.error));
      const raw = parsed.data;
      const items = raw.items ?? [];
      const ownedElsewhereSignal = raw.owned_elsewhere === true;
      const onboardedAt = raw.onboarded_at ?? '';

      // account_only: empty `items` is expected. A returning own user is a
      // success, not `already_registered`; only an explicit `owned_elsewhere`
      // marks a foreign user. Must run before the with-item check below.
      if (submitMode === 'account_only') {
        return ok({
          user_id: raw.user_id,
          profile_item_id: '',
          onboarded_at: onboardedAt,
          already_registered: false,
          owned_elsewhere: ownedElsewhereSignal,
        });
      }
      // with_item: an existing user with no items belongs to another
      // aggregator. Return it as owned_elsewhere so the caller records `skipped`.
      if ((raw.user_existed === true || ownedElsewhereSignal) && items.length === 0) {
        return ok({
          user_id: raw.user_id,
          profile_item_id: '',
          onboarded_at: onboardedAt,
          already_registered: true,
          owned_elsewhere: true,
        });
      }
      // `profile_item_id` is the item matching network/domain/type, else the
      // first item. Only that item is checked; see OnboardResponseSchema.
      const matchedIndex = items.findIndex((it) => {
        const identity = ItemIdentitySchema.safeParse(it);
        return (
          identity.success &&
          identity.data.item_network === input.network &&
          identity.data.item_domain === input.domain &&
          identity.data.item_type === input.item_type
        );
      });
      const chosenIndex = matchedIndex === -1 ? 0 : matchedIndex;
      if (items.length === 0) {
        return err(
          new UpstreamError('signalstack onboard returned no item for the request', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { item_count: 0 },
          }),
        );
      }
      const chosen = ChosenItemSchema.safeParse(items[chosenIndex]);
      if (!chosen.success) {
        return err(badResponseError('onboard', chosen.error, `items.${chosenIndex}`));
      }
      const matched = chosen.data;
      const lifecycleStatus =
        matched.lifecycle_status === 'draft' ||
        matched.lifecycle_status === 'live' ||
        matched.lifecycle_status === 'paused'
          ? matched.lifecycle_status
          : undefined;
      const result: SignalStackOnboardParticipantResult = {
        user_id: raw.user_id,
        profile_item_id: matched.item_id,
        onboarded_at: onboardedAt,
        owned_elsewhere: false,
        ...(lifecycleStatus !== undefined ? { lifecycle_status: lifecycleStatus } : {}),
      };
      return ok(result);
    } catch (e) {
      return err(this.transportError('onboard', e));
    }
  }

  /**
   * Calls `POST /api/v1/admin/aggregator/upsert` with the configured
   * `x-acting-org-id`. Idempotent on `external_id`, so it is safe to retry.
   *
   * @param input - external_id (coordinator `users.id`), display name, slug, optional metadata.
   * @returns ok(SignalStackAggregator) on 2xx with a non-empty `org_id`; err(BaseError) otherwise.
   */
  override async upsertAggregator(
    input: SignalStackUpsertAggregatorInput,
  ): Promise<Result<SignalStackAggregator, BaseError>> {
    if (!input?.external_id || !input?.name || !input?.slug) {
      return err(
        new ValidationError('external_id, name, and slug are required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    if (!this.actingOrgId) {
      return err(
        new UpstreamError('actingOrgId is required for aggregator upsert', {
          code: 'SIGNALSTACK_CONFIG_MISSING',
        }),
      );
    }

    const url = `${this.baseUrl}/api/v1/admin/aggregator/upsert`;
    const body: Record<string, unknown> = {
      external_id: input.external_id,
      name: input.name,
      slug: input.slug,
    };
    if (input.domains && input.domains.length > 0) body.domains = input.domains;
    if (input.metadata) body.metadata = input.metadata;

    const headersResult = await this.buildHeaders();
    if (!headersResult.success) return err(headersResult.error);
    const headers = {
      ...headersResult.value,
      'x-acting-org-id': this.actingOrgId,
      ...(input.requestId ? { 'x-request-id': input.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return await this.parseUpsertResponse(res, input);
    } catch (e) {
      return err(this.transportError('aggregator upsert', e));
    }
  }

  /**
   * Maps a signalstack aggregator-upsert response to a Result.
   *
   * Signals returns only `{ org_id, created }`, so the other aggregator fields
   * come from the request.
   */
  private async parseUpsertResponse(
    res: Response,
    input: SignalStackUpsertAggregatorInput,
  ): Promise<Result<SignalStackAggregator, BaseError>> {
    if (!res.ok) {
      const bodyText = await safeReadText(res);
      const upstreamMsg = extractUpstreamMessage(bodyText);
      const message = upstreamMsg
        ? `signalstack aggregator upsert returned ${res.status}: ${upstreamMsg}`
        : `signalstack aggregator upsert returned ${res.status}`;
      return err(
        new UpstreamError(message, {
          code: this.codeForStatus(res.status),
          details: { status: res.status },
        }),
      );
    }
    const json = await readJsonBody(res, 'signalstack aggregator upsert');
    if (!json.success) return json;
    const parsed = UpsertAggregatorResponseSchema.safeParse(json.value);
    if (!parsed.success) return err(badResponseError('aggregator upsert', parsed.error));
    return ok({
      org_id: parsed.data.org_id,
      external_id: input.external_id,
      name: input.name,
      slug: input.slug,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  }

  /**
   * Fetches the aggregator dashboard payload from signalstack.
   *
   * Sends `page`, `limit`, `status`, `lifecycle`, and `refresh`. `domain` is
   * not sent; signalstack does not accept it.
   *
   * @param query - actingOrgId plus optional pagination/status/domain.
   * @returns ok(SignalStackDashboardPage) on 2xx; err(BaseError) otherwise.
   */
  override async fetchDashboard(
    query: SignalStackDashboardQuery,
  ): Promise<Result<SignalStackDashboardPage, BaseError>> {
    if (!query?.actingOrgId) {
      return err(
        new ValidationError('actingOrgId is required for dashboard fetch', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.status) params.set('status', query.status);
    if (query.lifecycle && query.lifecycle.length > 0)
      params.set('lifecycle', query.lifecycle.join(','));
    if (query.refresh) params.set('refresh', 'true');
    const qs = params.toString();
    const url = `${this.baseUrl}/api/v1/aggregator/dashboard${qs ? `?${qs}` : ''}`;

    const headersResult = await this.buildHeaders();
    if (!headersResult.success) return err(headersResult.error);
    const headers = {
      ...headersResult.value,
      'x-acting-org-id': query.actingOrgId,
      ...(query.requestId ? { 'x-request-id': query.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(url, {
        method: 'GET',
        headers,
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        const message = upstreamMsg
          ? `signalstack dashboard returned ${res.status}: ${upstreamMsg}`
          : `signalstack dashboard returned ${res.status}`;
        return err(
          new UpstreamError(message, {
            code: this.codeForStatus(res.status),
            details: { status: res.status },
          }),
        );
      }

      const json = await readJsonBody(res, 'signalstack dashboard');
      if (!json.success) return json;
      const parsed = DashboardResponseSchema.safeParse(json.value);
      if (!parsed.success) return err(badResponseError('dashboard', parsed.error));
      return ok(parsed.data);
    } catch (e) {
      return err(this.transportError('dashboard', e));
    }
  }

  /**
   * Downloads the aggregator dashboard as a CSV file from signalstack.
   *
   * Sends `status` and `refresh` only; `domain` is not sent. Requests
   * `accept: text/csv` and returns the raw CSV body. The default filename has
   * the status filter and the UTC date.
   *
   * @param query - actingOrgId plus optional status/domain.
   * @returns ok(SignalStackDashboardExport) on 2xx; err(BaseError) otherwise.
   */
  override async exportDashboardCsv(
    query: SignalStackDashboardExportQuery,
  ): Promise<Result<SignalStackDashboardExport, BaseError>> {
    if (!query?.actingOrgId) {
      return err(
        new ValidationError('actingOrgId is required for dashboard export', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.refresh) params.set('refresh', 'true');
    const qs = params.toString();
    const url = `${this.baseUrl}/api/v1/aggregator/dashboard/export${qs ? `?${qs}` : ''}`;

    const headersResult = await this.buildHeaders();
    if (!headersResult.success) return err(headersResult.error);
    const headers = {
      ...headersResult.value,
      'x-acting-org-id': query.actingOrgId,
      accept: 'text/csv',
      ...(query.requestId ? { 'x-request-id': query.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(url, {
        method: 'GET',
        headers,
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        const message = upstreamMsg
          ? `signalstack dashboard export returned ${res.status}: ${upstreamMsg}`
          : `signalstack dashboard export returned ${res.status}`;
        return err(
          new UpstreamError(message, {
            code: this.codeForStatus(res.status),
            details: { status: res.status },
          }),
        );
      }

      const csv = await safeReadText(res);
      if (!csv) {
        return err(
          new UpstreamError('signalstack dashboard export returned empty body', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
          }),
        );
      }
      return ok({ csv, filename: buildDefaultExportFilename(query.status) });
    } catch (e) {
      return err(this.transportError('dashboard export', e));
    }
  }

  override async fetchDecryptedProfiles(
    query: SignalStackFetchDecryptedProfilesQuery,
  ): Promise<Result<SignalStackDecryptedProfiles, BaseError>> {
    if (!query?.actingOrgId) {
      return err(
        new ValidationError('actingOrgId is required for decrypted profile fetch', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    if (!Array.isArray(query.itemIds) || query.itemIds.length === 0) {
      return err(
        new ValidationError('itemIds must be a non-empty array', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    const url = `${this.baseUrl}/api/v1/admin/participant/decrypt`;
    const headersResult = await this.buildHeaders();
    if (!headersResult.success) return err(headersResult.error);
    const headers = {
      ...headersResult.value,
      'x-acting-org-id': query.actingOrgId,
      ...(query.requestId ? { 'x-request-id': query.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          item_ids: query.itemIds,
          ...(query.fields !== undefined ? { fields: query.fields } : {}),
          ...(query.contact !== undefined ? { contact: query.contact } : {}),
        }),
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        const message = upstreamMsg
          ? `signalstack decrypt returned ${res.status}: ${upstreamMsg}`
          : `signalstack decrypt returned ${res.status}`;
        return err(
          new UpstreamError(message, {
            code: this.codeForStatus(res.status),
            details: { status: res.status },
          }),
        );
      }

      const json = await readJsonBody(res, 'signalstack decrypt');
      if (!json.success) return json;
      const parsed = DecryptProfilesResponseSchema.safeParse(json.value);
      if (!parsed.success) return err(badResponseError('decrypt', parsed.error));
      return ok(parsed.data);
    } catch (e) {
      return err(this.transportError('decrypt', e));
    }
  }

  /**
   * Read-only identity probe via `GET /admin/participant`. Safe to retry.
   *
   * Signalstack returns `{ user_id, items }`, with `items` limited to the
   * acting org. The result is mapped to {@link SignalStackProbeUserResult}:
   *   - `user_id` null             → new identity
   *   - `user_id` + owned items     → own user (+ lifecycle summary)
   *   - `user_id` + no owned items  → user exists under a different aggregator
   *
   * @param input - actingOrgId, email and/or phoneNumber, network, and domain.
   * @returns ok(SignalStackProbeUserResult) on 2xx; err(BaseError) otherwise.
   */
  override async probeUser(
    input: SignalStackProbeUserInput,
  ): Promise<Result<SignalStackProbeUserResult, BaseError>> {
    if (!input?.actingOrgId) {
      return err(
        new ValidationError('actingOrgId is required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    if (!input.email && !input.phoneNumber) {
      return err(
        new ValidationError('email or phoneNumber required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    if (!input.network || !input.domain) {
      return err(
        new ValidationError('network and domain are required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    // Email and phone are sent in the query string. The signals ingress must
    // keep `/admin/participant` query strings out of its access log.
    const params = new URLSearchParams();
    if (input.email) params.set('email', input.email);
    if (input.phoneNumber) params.set('phone_number', input.phoneNumber);
    const url = `${this.endpoint}?${params.toString()}`;

    const headersResult = await this.buildHeaders();
    if (!headersResult.success) return err(headersResult.error);
    const headers = {
      ...headersResult.value,
      'x-acting-org-id': input.actingOrgId,
      ...(input.requestId ? { 'x-request-id': input.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(url, {
        method: 'GET',
        headers,
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        const message = upstreamMsg
          ? `signalstack probe returned ${res.status}: ${upstreamMsg}`
          : `signalstack probe returned ${res.status}`;
        if (res.status === 400) {
          return err(
            new ValidationError(message, {
              code: this.codeForStatus(res.status),
              details: { status: res.status },
            }),
          );
        }
        if (res.status === 401 || res.status === 403) {
          return err(
            new AuthError(message, {
              code: this.codeForStatus(res.status),
              details: { status: res.status },
            }),
          );
        }
        return err(
          new UpstreamError(message, {
            code: this.codeForStatus(res.status),
            details: { status: res.status },
          }),
        );
      }

      // `items` holds only this aggregator's items, across all domains. It is
      // required, so a missing list fails instead of reading as owned elsewhere.
      const json = await readJsonBody(res, 'signalstack probe');
      if (!json.success) return json;
      const parsed = ProbeUserResponseSchema.safeParse(json.value);
      if (!parsed.success) return err(badResponseError('probe', parsed.error));
      const { user_id: userId, items } = parsed.data;

      // No matching identity: a new user.
      if (!userId) {
        return ok({
          user_exists: false,
          owned_elsewhere: false,
          lifecycle_summary: null,
        });
      }

      // No items owned by this aggregator: owned elsewhere.
      if (items.length === 0) {
        return ok({
          user_exists: true,
          owned_elsewhere: true,
          lifecycle_summary: null,
        });
      }

      // The primary item must match the probed network and domain, since
      // `items` can include other domains. Only that item is checked.
      const domainIndex = items.findIndex((it) => {
        const identity = ItemIdentitySchema.safeParse(it);
        return (
          identity.success &&
          identity.data.item_domain === input.domain &&
          identity.data.item_network === input.network
        );
      });

      // Own user with no item in this domain: no lifecycle summary.
      if (domainIndex === -1) {
        return ok({
          user_exists: true,
          owned_elsewhere: false,
          lifecycle_summary: null,
        });
      }

      const domainItem = ChosenItemSchema.safeParse(items[domainIndex]);
      if (!domainItem.success) {
        return err(badResponseError('probe', domainItem.error, `items.${domainIndex}`));
      }
      const itemId = domainItem.data.item_id;

      // lifecycle_status mapping:
      //   - absent/empty      → 'live' (older signals builds omit it).
      //   - draft/live/paused → used as-is.
      //   - retired           → no summary; not resumable.
      //   - anything else     → SIGNALSTACK_BAD_RESPONSE.
      const rawLifecycle = domainItem.data.lifecycle_status;
      if (rawLifecycle === 'retired') {
        return ok({
          user_exists: true,
          owned_elsewhere: false,
          lifecycle_summary: null,
        });
      }
      let lifecycleStatus: 'draft' | 'live' | 'paused';
      if (!rawLifecycle) {
        lifecycleStatus = 'live';
      } else if (rawLifecycle === 'draft' || rawLifecycle === 'live' || rawLifecycle === 'paused') {
        lifecycleStatus = rawLifecycle;
      } else {
        return err(
          new UpstreamError(
            `signalstack probe returned unknown lifecycle_status: ${rawLifecycle}`,
            {
              code: 'SIGNALSTACK_BAD_RESPONSE',
            },
          ),
        );
      }
      return ok({
        user_exists: true,
        owned_elsewhere: false,
        lifecycle_summary: {
          primary_item: {
            item_id: itemId,
            lifecycle_status: lifecycleStatus,
          },
        },
      });
    } catch (e) {
      return err(this.transportError('probe', e));
    }
  }

  private guardInput(input: SignalStackOnboardParticipantInput): BaseError | null {
    // Input errors are ValidationError with code SIGNALSTACK_INPUT_INVALID.
    if (!input?.actingOrgId) {
      return new ValidationError('actingOrgId is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    if (!input.name) {
      return new ValidationError('name is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    const hasEmail = Boolean(input.email);
    const hasPhone = Boolean(input.phoneNumber);
    if (!hasEmail && !hasPhone) {
      return new ValidationError('either email or phoneNumber is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    if (!input.network || !input.domain || !input.item_type) {
      return new ValidationError('network, domain, and item_type are required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    if (!input.source_id || !input.channel) {
      return new ValidationError('channel and source_id are required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    if (!input.profile || typeof input.profile !== 'object') {
      return new ValidationError('profile is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    return null;
  }

  /**
   * Picks the error code for a rejected onboard.
   *
   * The per-user profile cap and an out-of-country coordinate get their own
   * codes; anything else uses the status-based code.
   */
  private onboardErrorCode(status: number, upstreamCode: string | null): string {
    if (status === 409 && upstreamCode === 'PROFILE_LIMIT_REACHED') {
      return 'SIGNALSTACK_PROFILE_LIMIT_REACHED';
    }
    if (status === 400 && upstreamCode === 'LOCATION_OUTSIDE_COUNTRY') {
      return 'SIGNALSTACK_LOCATION_OUTSIDE_COUNTRY';
    }
    return this.codeForStatus(status);
  }

  private codeForStatus(status: number): string {
    if (status === 400) return 'SIGNALSTACK_BAD_REQUEST';
    if (status === 401 || status === 403) return 'SIGNALSTACK_FORBIDDEN';
    if (status === 404) return 'SIGNALSTACK_NOT_FOUND';
    if (status === 409) return 'SIGNALSTACK_CONFLICT';
    if (status >= 500) return 'SIGNALSTACK_SERVER_ERROR';
    return 'SIGNALSTACK_UPSTREAM_ERROR';
  }

  /**
   * Maps a thrown request error to an UpstreamError.
   *
   * @param operation - Operation name used in the message, e.g. `onboard`.
   * @param e - The value thrown by {@link requestWithRetry} or by reading the body.
   */
  private transportError(operation: string, e: unknown): UpstreamError {
    const cause = toError(e);
    const aborted = isTimeout(e);
    return new UpstreamError(
      aborted
        ? `signalstack ${operation} timed out after ${this.timeoutMs}ms`
        : `signalstack ${operation} transport failure: ${cause.message}`,
      { cause, code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED' },
    );
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Builds the error for a 2xx response that does not match its schema.
 *
 * The message and details hold field paths and issue codes only. The
 * response can hold participant data, so it is never attached.
 */
function badResponseError(
  operation: string,
  error: z.ZodError,
  pathPrefix: string = '',
): UpstreamError {
  const issues = responseIssues(error, pathPrefix);
  const where = issues.map((issue) => `${issue.path || '(root)'} (${issue.code})`).join(', ');
  return new UpstreamError(`signalstack ${operation} returned an unexpected payload: ${where}`, {
    code: 'SIGNALSTACK_BAD_RESPONSE',
    details: { issues },
  });
}

/** Parses a JSON error body. Returns `null` for an empty, non-JSON, or non-object body. */
function parseJsonObject(bodyText: string): Record<string, unknown> | null {
  if (!bodyText) return null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads `obj[key]` when it is a string. */
function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' ? value : null;
}

/** Extracts signalstack's machine error code from a JSON error body, if any. */
function extractUpstreamCode(bodyText: string): string | null {
  const obj = parseJsonObject(bodyText);
  if (!obj) return null;
  // Fastify validation errors put the code in `code`; signals puts it in `error`.
  const code = stringField(obj, 'code');
  if (code && /^[A-Z][A-Z0-9_]+$/.test(code)) return code;
  const errField = obj['error'];
  if (typeof errField === 'string') return errField;
  return isObject(errField) ? stringField(errField, 'code') : null;
}

/**
 * Extracts the per-field error map (`fields: { <field>: <message> }`) from a
 * JSON error body. Only string entries are kept.
 */
function extractUpstreamFields(bodyText: string): Record<string, string> | null {
  const fields = parseJsonObject(bodyText)?.['fields'];
  if (!isObject(fields)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (typeof v === 'string') out[k] = v;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Extracts the `message` from a JSON error body, without the `"<CODE>: "`
 * prefix that {@link extractUpstreamMessage} adds. Safe to show end users.
 */
function extractUpstreamMessageText(bodyText: string): string | null {
  const obj = parseJsonObject(bodyText);
  if (!obj) return null;
  const errField = obj['error'];
  return (
    stringField(obj, 'message') ?? (isObject(errField) ? stringField(errField, 'message') : null)
  );
}

/**
 * Extracts a readable error string from a signalstack error body.
 *
 * Handles shapes like:
 *   { "error": "INVALID_ITEM_STATE", "message": "Invalid item_state: must be …" }
 *   { "statusCode": 400, "error": "Bad Request", "message": "body/x Invalid …" }
 *   { "error": { "message": "…" } }
 *
 * Returns `"<code>: <message>"` when both exist. Returns `null` for a
 * non-JSON body, such as a proxy error page: its text can echo participant
 * data, and the message reaches operator logs and errors.csv.
 */
function extractUpstreamMessage(bodyText: string): string | null {
  if (!bodyText) return null;
  const parsed = parseJsonObject(bodyText);
  if (!parsed) return null;
  const errField = parsed['error'];
  const errCode =
    typeof errField === 'string'
      ? errField
      : isObject(errField)
        ? stringField(errField, 'code')
        : null;
  const messageText =
    stringField(parsed, 'message') ??
    (isObject(errField) ? stringField(errField, 'message') : null);
  if (errCode && messageText) return `${errCode}: ${messageText}`;
  if (messageText) return messageText;
  if (errCode) return errCode;
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Default filename for the dashboard CSV export.
 *
 * Includes the status filter (or `all`) and the UTC date. The status is
 * sanitised so it cannot inject path separators or quotes into the
 * `Content-Disposition` header.
 */
function buildDefaultExportFilename(status: string | undefined): string {
  const sanitised = (status ?? 'all')
    .replace(/[^a-z0-9_]/gi, '_')
    .slice(0, MAX_FILENAME_STATUS_CHARS);
  const date = new Date().toISOString().slice(0, 10);
  return `aggregator-dashboard-${sanitised}-${date}.csv`;
}
