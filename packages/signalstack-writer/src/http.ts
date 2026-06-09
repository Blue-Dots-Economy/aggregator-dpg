/**
 * Fetch-backed SignalStackWriter — production impl.
 *
 * Calls `POST {baseUrl}/api/v1/admin/onboard` with `x-api-key`. Any non-2xx
 * response, network failure, or shape mismatch is mapped to UpstreamError so
 * the caller never sees a thrown exception.
 *
 * Retries are NOT performed here — idempotency strategy is a higher-level
 * concern (see notes in the design doc). One call → one network attempt.
 */

import {
  AuthError,
  UpstreamError,
  ValidationError,
} from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

import {
  SignalStackWriterBase,
  type SignalStackAggregator,
  type SignalStackDashboardExport,
  type SignalStackDashboardExportQuery,
  type SignalStackDashboardPage,
  type SignalStackDashboardQuery,
  type SignalStackGetItemQuery,
  type SignalStackItemList,
  type SignalStackItemQuery,
  type SignalStackOnboardParticipantInput,
  type SignalStackOnboardParticipantResult,
  type SignalStackProbeUserInput,
  type SignalStackProbeUserResult,
  type SignalStackProfile,
  type SignalStackUpsertAggregatorInput,
} from './interface.js';

export interface HttpSignalStackWriterConfig {
  /** Base URL of the signalstack API, e.g. `http://localhost:2743`. No trailing slash. */
  baseUrl: string;
  /** Admin api-key issued by signalstack via better-auth. Sent as `x-api-key`. */
  apiKey: string;
  /**
   * Platform-wide signalstack organisation id under which admin upserts
   * are performed. Sent as `x-acting-org-id` on the
   * `POST /api/v1/admin/aggregator/upsert` call. Required for that call;
   * other endpoints ignore it.
   */
  actingOrgId?: string;
  /** Optional override; defaults to global `fetch`. Lets tests inject a stub. */
  fetchImpl?: typeof fetch;
  /** Optional request timeout in ms; off by default. */
  timeoutMs?: number;
}

export class HttpSignalStackWriter extends SignalStackWriterBase {
  private readonly baseUrl: string;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  /**
   * Signalstack organisation id sent as `x-acting-org-id` on the aggregator
   * upsert call. `undefined` when not configured — the upsert method then
   * returns `SIGNALSTACK_CONFIG_MISSING` so the caller can soft-fail.
   */
  private readonly actingOrgId: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;

  constructor(config: HttpSignalStackWriterConfig) {
    super();
    if (!config.baseUrl) {
      throw new Error('HttpSignalStackWriter requires baseUrl');
    }
    if (!config.apiKey) {
      throw new Error('HttpSignalStackWriter requires apiKey');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    // Plan-C tier-aware participant upsert. Replaced the old
    // `/admin/onboard_participant` route which now returns 404.
    this.endpoint = `${this.baseUrl}/api/v1/admin/participant`;
    this.headers = {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
    };
    this.actingOrgId = config.actingOrgId;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs;
  }

  override async onboard(
    input: SignalStackOnboardParticipantInput,
  ): Promise<Result<SignalStackOnboardParticipantResult, BaseError>> {
    const guardErr = this.guardInput(input);
    if (guardErr) return err(guardErr);

    const submitMode: 'with_item' | 'account_only' = input.submit_mode ?? 'with_item';
    const body: Record<string, unknown> = {
      name: input.name,
      terms_accepted: input.terms_accepted,
      privacy_accepted: input.privacy_accepted,
      channel: input.channel,
      source_id: input.source_id,
      network: input.network,
      domain: input.domain,
      item_type: input.item_type,
    };
    // Signalstack Plan-C renamed the body field from `profile` to
    // `item_state` — the value is unchanged. When the caller opts out of
    // item creation (`submit_mode === 'account_only'`), omit `item_state`
    // entirely so signals creates only the user row. This is the
    // upstream-friendly way to flag "account only": signals' own contract
    // treats an absent item_state as "no item" rather than introducing a
    // bespoke flag.
    if (submitMode !== 'account_only') {
      body.item_state = input.profile;
    }
    // Signalstack's user schema treats email / phoneNumber as `.optional()`
    // (not `.nullable()`), so omit the keys entirely when we have no value
    // rather than passing null — a literal null trips Zod's `expected:
    // string` check and the whole push fails 400.
    if (input.phoneNumber) body.phone_number = input.phoneNumber;
    if (input.email) body.email = input.email;

    const headers = {
      ...this.headers,
      'x-acting-org-id': input.actingOrgId,
    };

    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        // Surface signalstack's own message (e.g. `INVALID_ITEM_STATE: must be
        // equal to one of the allowed values`) when present so the caller can
        // funnel it into the user-visible errors.csv. Falls back to the bare
        // status code message if the body isn't JSON or carries no message.
        const message = upstreamMsg
          ? `signalstack onboard returned ${res.status}: ${upstreamMsg}`
          : `signalstack onboard returned ${res.status}`;
        return err(
          new UpstreamError(message, {
            code: this.codeForStatus(res.status),
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      // Plan-C response shape:
      //   { user_id, user_existed, onboarded_at, items: [{ item_id, lifecycle_status?, completion_pct?, ... }] }
      // The writer's public result still surfaces a flat
      // `profile_item_id` so existing callers (worker, registration-link
      // routes, audit logs) stay unchanged — pick the matching item for
      // the requested network/domain/type, falling back to the first
      // item when the request inserted a single row.
      const raw = (await res.json()) as {
        user_id?: unknown;
        user_existed?: unknown;
        owned_elsewhere?: unknown;
        items?: Array<{
          item_id?: unknown;
          item_network?: unknown;
          item_domain?: unknown;
          item_type?: unknown;
          lifecycle_status?: unknown;
          completion_pct?: unknown;
        }>;
        onboarded_at?: unknown;
      };
      if (!raw || typeof raw !== 'object' || typeof raw.user_id !== 'string') {
        return err(
          new UpstreamError('signalstack onboard returned unexpected payload', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload: raw },
          }),
        );
      }
      const items = Array.isArray(raw.items) ? raw.items : [];
      const ownedElsewhereSignal = raw.owned_elsewhere === true;

      // account_only path — signalstack created the user row but no item, so
      // an empty `items` array is EXPECTED here, not a sign of foreign
      // ownership. Derive ownership solely from the explicit `owned_elsewhere`
      // signal; a returning own-aggregator user (`user_existed: true`) surfaces
      // as `already_registered` (the caller maps that to a `skipped` dedup),
      // NOT as `owned_elsewhere`. Checked BEFORE the with-item heuristic below
      // precisely because that heuristic treats empty items as owned-elsewhere.
      if (submitMode === 'account_only') {
        return ok({
          user_id: raw.user_id,
          profile_item_id: '',
          onboarded_at: typeof raw.onboarded_at === 'string' ? raw.onboarded_at : '',
          already_registered: raw.user_existed === true,
          owned_elsewhere: ownedElsewhereSignal,
        });
      }
      // with_item path — an existing user with an empty `items` array belongs
      // to a different aggregator (that org's items are private to it).
      // signalstack returns `user_existed: true` (and, in newer builds, an
      // explicit `owned_elsewhere: true`). Not an error — surface it as an
      // already-registered / owned_elsewhere result so the caller records a
      // `skipped` outcome instead of a 502.
      if ((raw.user_existed === true || ownedElsewhereSignal) && items.length === 0) {
        return ok({
          user_id: raw.user_id,
          profile_item_id: '',
          onboarded_at: typeof raw.onboarded_at === 'string' ? raw.onboarded_at : '',
          already_registered: true,
          owned_elsewhere: true,
        });
      }
      const matched =
        items.find(
          (it) =>
            it.item_network === input.network &&
            it.item_domain === input.domain &&
            it.item_type === input.item_type,
        ) ?? items[0];
      if (!matched || typeof matched.item_id !== 'string') {
        return err(
          new UpstreamError('signalstack onboard returned no item for the request', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload: raw },
          }),
        );
      }
      const lifecycleStatus =
        matched.lifecycle_status === 'draft' ||
        matched.lifecycle_status === 'live' ||
        matched.lifecycle_status === 'paused'
          ? matched.lifecycle_status
          : undefined;
      const completionPct =
        typeof matched.completion_pct === 'number' &&
        matched.completion_pct >= 0 &&
        matched.completion_pct <= 100
          ? matched.completion_pct
          : undefined;
      const result: SignalStackOnboardParticipantResult = {
        user_id: raw.user_id,
        profile_item_id: matched.item_id,
        onboarded_at: typeof raw.onboarded_at === 'string' ? raw.onboarded_at : '',
        owned_elsewhere: false,
        ...(lifecycleStatus !== undefined ? { lifecycle_status: lifecycleStatus } : {}),
        ...(completionPct !== undefined ? { completion_pct: completionPct } : {}),
      };
      return ok(result);
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack onboard timed out after ${this.timeoutMs}ms`
            : `signalstack onboard transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  override async listItemsByAggregator(
    query: SignalStackItemQuery,
  ): Promise<Result<SignalStackItemList, BaseError>> {
    if (!query.aggregator_id || !query.item_network || !query.item_domain) {
      return err(
        new UpstreamError('aggregator_id, item_network, and item_domain are required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    // Local-only network fetch (POST): hits this signalstack instance's
    // items table directly with the aggregator_id filter. The sibling GET
    // /api/v1/network/item/fetch aggregates across every instance listed in
    // the network config and external instances do not know about
    // aggregator_id, so totals there are inflated. fetch_local is the
    // correct endpoint for an aggregator dashboard scoped to its own data.
    const url = `${this.baseUrl}/api/v1/network/item/fetch_local`;
    const body = {
      aggregator_id: query.aggregator_id,
      item_network: query.item_network,
      item_domain: query.item_domain,
      ...(query.item_type ? { item_type: query.item_type } : {}),
      // Forward the lifecycle filter only when set; signals defaults to
      // 'live_only' so the writer omits the field for that case to keep
      // the wire shape minimal and let signals own the default.
      ...(query.lifecycle_filter ? { lifecycle_filter: query.lifecycle_filter } : {}),
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    };
    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        return err(
          new UpstreamError(`signalstack list_items returned ${res.status}`, {
            code: this.codeForStatus(res.status),
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      const payload = (await res.json()) as SignalStackItemList;
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
        return err(
          new UpstreamError('signalstack list_items returned unexpected payload', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload },
          }),
        );
      }
      return ok(payload);
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack list_items timed out after ${this.timeoutMs}ms`
            : `signalstack list_items transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Calls `POST {baseUrl}/api/v1/admin/aggregator/upsert` with the platform
   * admin api-key and the configured `x-acting-org-id` header. The remote
   * endpoint is idempotent on `external_id` (our Postgres aggregator UUID),
   * so the same input may be re-fired safely from a login-time fallback.
   *
   * Non-2xx responses, transport failures, and unexpected payload shapes
   * are mapped to `UpstreamError` — no exception ever leaves the method.
   *
   * @param input - external_id (our aggregator UUID) + display name + slug
   *   + optional metadata bag forwarded verbatim to signalstack.
   * @returns ok(SignalStackAggregator) on 2xx with a non-empty `org_id`;
   *   err(BaseError) with a `SIGNALSTACK_*` code on every failure path.
   */
  override async upsertAggregator(
    input: SignalStackUpsertAggregatorInput,
  ): Promise<Result<SignalStackAggregator, BaseError>> {
    if (!input?.external_id || !input?.name || !input?.slug) {
      return err(
        new UpstreamError('external_id, name, and slug are required', {
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

    const headers = {
      ...this.headers,
      'x-acting-org-id': this.actingOrgId,
    };

    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        const message = upstreamMsg
          ? `signalstack aggregator upsert returned ${res.status}: ${upstreamMsg}`
          : `signalstack aggregator upsert returned ${res.status}`;
        return err(
          new UpstreamError(message, {
            code: this.codeForStatus(res.status),
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      const payload = (await res.json()) as SignalStackAggregator;
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.org_id !== 'string' ||
        payload.org_id.length === 0
      ) {
        return err(
          new UpstreamError('signalstack aggregator upsert returned unexpected payload', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload },
          }),
        );
      }
      return ok(payload);
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack aggregator upsert timed out after ${this.timeoutMs}ms`
            : `signalstack aggregator upsert transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Fetches the aggregator dashboard payload from signalstack.
   *
   * Builds a query string from `page`, `limit`, and `status` only — the
   * `domain` field is reserved for the eventual provider rollout and is
   * intentionally NOT forwarded today because signalstack's dashboard
   * endpoint is seeker-only at present. When upstream gains domain
   * support, swap the predicate that gates the `domain` append below.
   *
   * @param query - actingOrgId + optional pagination/status/domain.
   * @returns ok(SignalStackDashboardPage) on 2xx; err(BaseError) otherwise.
   */
  override async fetchDashboard(
    query: SignalStackDashboardQuery,
  ): Promise<Result<SignalStackDashboardPage, BaseError>> {
    if (!query?.actingOrgId) {
      return err(
        new UpstreamError('actingOrgId is required for dashboard fetch', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.status) params.set('status', query.status);
    if (query.refresh) params.set('refresh', 'true');
    // domain intentionally NOT forwarded — see method docblock.
    const qs = params.toString();
    const url = `${this.baseUrl}/api/v1/aggregator/dashboard${qs ? `?${qs}` : ''}`;

    const headers = {
      ...this.headers,
      'x-acting-org-id': query.actingOrgId,
    };

    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;

    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        ...(controller ? { signal: controller.signal } : {}),
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
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      const payload = (await res.json()) as SignalStackDashboardPage;
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('by_domain' in payload) ||
        !payload.by_domain ||
        typeof payload.by_domain !== 'object'
      ) {
        return err(
          new UpstreamError('Signalstack dashboard payload missing by_domain', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
          }),
        );
      }
      if (!payload.metadata || typeof payload.metadata !== 'object') {
        return err(
          new UpstreamError('Signalstack dashboard payload missing metadata', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
          }),
        );
      }

      const byDomain = payload.by_domain as Record<string, unknown>;
      for (const [domainId, sliceRaw] of Object.entries(byDomain)) {
        if (!sliceRaw || typeof sliceRaw !== 'object') {
          return err(
            new UpstreamError(`Signalstack domain slice "${domainId}" is not an object`, {
              code: 'SIGNALSTACK_BAD_RESPONSE',
            }),
          );
        }
        const slice = sliceRaw as Record<string, unknown>;
        if (!Array.isArray(slice.items)) {
          return err(
            new UpstreamError(`Signalstack slice "${domainId}" missing items[]`, {
              code: 'SIGNALSTACK_BAD_RESPONSE',
            }),
          );
        }
        if (!slice.rollup || typeof slice.rollup !== 'object') {
          return err(
            new UpstreamError(`Signalstack slice "${domainId}" missing rollup`, {
              code: 'SIGNALSTACK_BAD_RESPONSE',
            }),
          );
        }
        const r = slice.rollup as Record<string, unknown>;
        if (typeof r.total_items !== 'number') {
          return err(
            new UpstreamError(`Signalstack slice "${domainId}" rollup missing total_items`, {
              code: 'SIGNALSTACK_BAD_RESPONSE',
            }),
          );
        }
        if (!r.by_action_status || typeof r.by_action_status !== 'object') {
          return err(
            new UpstreamError(`Signalstack slice "${domainId}" rollup missing by_action_status`, {
              code: 'SIGNALSTACK_BAD_RESPONSE',
            }),
          );
        }
        if (!r.by_status || typeof r.by_status !== 'object') {
          return err(
            new UpstreamError(`Signalstack slice "${domainId}" rollup missing by_status`, {
              code: 'SIGNALSTACK_BAD_RESPONSE',
            }),
          );
        }
      }
      return ok(payload);
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack dashboard timed out after ${this.timeoutMs}ms`
            : `signalstack dashboard transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Downloads the aggregator dashboard as a CSV file from signalstack.
   *
   * Forwards `status` as the only query parameter today (signalstack's
   * export endpoint accepts no others); `domain` is reserved for the
   * provider rollout and intentionally NOT forwarded. The
   * `accept: text/csv` header tells signalstack to return the CSV body
   * directly — the writer hands the raw string back and the route
   * streams it as `text/csv` with a `Content-Disposition` attachment
   * header.
   *
   * The default filename embeds the status filter and current date in
   * UTC; the API route may override.
   *
   * @param query - actingOrgId + optional status/domain.
   * @returns ok(SignalStackDashboardExport) on 2xx; err(BaseError) on
   *   transport failure, validation rejection, or non-2xx.
   */
  override async exportDashboardCsv(
    query: SignalStackDashboardExportQuery,
  ): Promise<Result<SignalStackDashboardExport, BaseError>> {
    if (!query?.actingOrgId) {
      return err(
        new UpstreamError('actingOrgId is required for dashboard export', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.refresh) params.set('refresh', 'true');
    const qs = params.toString();
    const url = `${this.baseUrl}/api/v1/aggregator/dashboard/export${qs ? `?${qs}` : ''}`;

    const headers = {
      ...this.headers,
      'x-acting-org-id': query.actingOrgId,
      accept: 'text/csv',
    };

    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;

    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        ...(controller ? { signal: controller.signal } : {}),
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
            details: { status: res.status, body: bodyText },
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
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack dashboard export timed out after ${this.timeoutMs}ms`
            : `signalstack dashboard export transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Identity-only probe against signalstack's `/admin/participant` endpoint.
   *
   * Calls the same POST endpoint as {@link onboard} but with no
   * `item_state` in the body and a sentinel `name: 'lookup'`. Signalstack
   * treats that as an account-only path — it may create the user row but
   * never an item — so the probe is safely idempotent for the caller.
   * The response is reshaped into the slim {@link SignalStackProbeUserResult}
   * tri-state so the caller never has to re-derive owned_elsewhere /
   * lifecycle_summary from the raw items array.
   *
   * @param input - actingOrgId + email and/or phoneNumber + network/domain.
   * @returns ok(SignalStackProbeUserResult) on 2xx; err(BaseError) on
   *   validation failure, transport failure, or non-2xx.
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

    // Probe body — deliberately omits `item_state` so signals' Plan-C
    // account-only path runs (creates user row at most; never an item).
    // The sentinel `name: 'lookup'` mirrors what signals' own admin UI
    // sends for identity-only checks. `channel` is required by signals'
    // UpsertParticipantRequest schema even on the account-only path; the
    // probe always originates from the public registration link, so 'link'
    // is the truthful attribution surface.
    const body: Record<string, unknown> = {
      name: 'lookup',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      network: input.network,
      domain: input.domain,
    };
    if (input.email) body.email = input.email;
    if (input.phoneNumber) body.phone_number = input.phoneNumber;

    const headers = {
      ...this.headers,
      'x-acting-org-id': input.actingOrgId,
    };

    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
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
              details: { status: res.status, body: bodyText },
            }),
          );
        }
        if (res.status === 401 || res.status === 403) {
          return err(
            new AuthError(message, {
              code: this.codeForStatus(res.status),
              details: { status: res.status, body: bodyText },
            }),
          );
        }
        return err(
          new UpstreamError(message, {
            code: this.codeForStatus(res.status),
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      // Account-only response shape:
      //   { user_id, user_existed, owned_elsewhere?, items: [] | [item] }
      // Reshape into the tri-state the caller branches on.
      const raw = (await res.json()) as {
        user_id?: unknown;
        user_existed?: unknown;
        owned_elsewhere?: unknown;
        items?: Array<{
          item_id?: unknown;
          lifecycle_status?: unknown;
          completion_pct?: unknown;
        }>;
      };
      if (!raw || typeof raw !== 'object') {
        return err(
          new UpstreamError('signalstack probe returned unexpected payload', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload: raw },
          }),
        );
      }

      const userExisted = raw.user_existed === true;
      const ownedElsewhere = raw.owned_elsewhere === true;

      if (userExisted && ownedElsewhere) {
        return ok({
          user_exists: true,
          owned_elsewhere: true,
          lifecycle_summary: null,
        });
      }

      const items = Array.isArray(raw.items) ? raw.items : [];
      if (userExisted && items.length > 0) {
        const first = items[0]!;
        const itemId = typeof first.item_id === 'string' ? first.item_id : '';
        if (!itemId) {
          return err(
            new UpstreamError('signalstack probe primary item missing item_id', {
              code: 'SIGNALSTACK_BAD_RESPONSE',
              details: { payload: raw },
            }),
          );
        }
        // Back-compat fallback: older signalstack builds omit lifecycle_status /
        // completion_pct on the account-only response. Treat absent values as
        // a live, fully-complete item — same default the resolveLifecycle
        // helper in apps/api applies for read-side rows. The writer cannot
        // import that helper (apps/api sits above this package in the dep
        // graph), so inline the fallback here.
        const lifecycleStatus =
          first.lifecycle_status === 'draft' ||
          first.lifecycle_status === 'live' ||
          first.lifecycle_status === 'paused'
            ? first.lifecycle_status
            : 'live';
        const completionPct =
          typeof first.completion_pct === 'number' &&
          first.completion_pct >= 0 &&
          first.completion_pct <= 100
            ? first.completion_pct
            : 100;
        return ok({
          user_exists: true,
          owned_elsewhere: false,
          lifecycle_summary: {
            primary_item: {
              item_id: itemId,
              lifecycle_status: lifecycleStatus,
              completion_pct: completionPct,
            },
          },
        });
      }

      if (userExisted) {
        // Own user but no item yet (account-only probe response).
        return ok({
          user_exists: true,
          owned_elsewhere: false,
          lifecycle_summary: null,
        });
      }

      // user_existed: false (or absent) — signals either created the row
      // just now or there is no matching identity. Either way the caller
      // treats the user as new.
      return ok({
        user_exists: false,
        owned_elsewhere: false,
        lifecycle_summary: null,
      });
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack probe timed out after ${this.timeoutMs}ms`
            : `signalstack probe transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Fetch a single signals item by `item_id` from the
   * `POST /api/v1/network/item/fetch_local` endpoint.
   *
   * Generic single-item read primitive. A 404 (or empty `items[]`) is
   * mapped to `ok(null)` so a caller can distinguish "absent" from an
   * error. All other non-2xx responses and transport failures surface as
   * `UpstreamError`.
   *
   * @param query - Item id to look up.
   * @returns ok(SignalStackProfile) on hit; ok(null) on absent;
   *   err(BaseError) on transport / protocol failure.
   */
  override async getItem(
    query: SignalStackGetItemQuery,
  ): Promise<Result<SignalStackProfile | null, BaseError>> {
    if (!query?.item_id) {
      return err(
        new ValidationError('item_id is required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    // fetch_local accepts a server-side `item_id` filter; signalstack
    // returns a list payload with 0 or 1 row. We collapse the list into
    // a single-item result here so the caller doesn't have to.
    const url = `${this.baseUrl}/api/v1/network/item/fetch_local`;
    const body = { item_id: query.item_id, limit: 1, offset: 0 };

    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });

      if (res.status === 404) return ok(null);

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        return err(
          new UpstreamError(`signalstack get_item returned ${res.status}`, {
            code: this.codeForStatus(res.status),
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      const payload = (await res.json()) as { items?: unknown };
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
        return err(
          new UpstreamError('signalstack get_item returned unexpected payload', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload },
          }),
        );
      }
      const first = payload.items[0];
      if (!first || typeof first !== 'object') return ok(null);
      return ok(first as SignalStackProfile);
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack get_item timed out after ${this.timeoutMs}ms`
            : `signalstack get_item transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private guardInput(input: SignalStackOnboardParticipantInput): BaseError | null {
    if (!input?.actingOrgId) {
      return new UpstreamError('actingOrgId is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    if (!input.name) {
      return new UpstreamError('name is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    const hasEmail = Boolean(input.email);
    const hasPhone = Boolean(input.phoneNumber);
    if (!hasEmail && !hasPhone) {
      return new UpstreamError('either email or phoneNumber is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    if (!input.network || !input.domain || !input.item_type) {
      return new UpstreamError('network, domain, and item_type are required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    if (!input.source_id || !input.channel) {
      return new UpstreamError('channel and source_id are required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    if (!input.profile || typeof input.profile !== 'object') {
      return new UpstreamError('profile is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    return null;
  }

  private codeForStatus(status: number): string {
    if (status === 400) return 'SIGNALSTACK_BAD_REQUEST';
    if (status === 401 || status === 403) return 'SIGNALSTACK_FORBIDDEN';
    if (status === 404) return 'SIGNALSTACK_NOT_FOUND';
    if (status === 409) return 'SIGNALSTACK_CONFLICT';
    if (status >= 500) return 'SIGNALSTACK_SERVER_ERROR';
    return 'SIGNALSTACK_UPSTREAM_ERROR';
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
 * Extract the human-readable error string from a signalstack JSON error body.
 *
 * Signalstack returns shapes like:
 *   { "error": "INVALID_ITEM_STATE", "message": "Invalid item_state: must be …" }
 *   { "statusCode": 400, "error": "Bad Request", "message": "body/x Invalid …" }
 *   { "error": { "message": "…" } }
 *
 * Returns the most specific message available, or `null` if the body is not
 * JSON or carries no usable text. Combines `error` + `message` when both are
 * present so the caller sees both the machine code and the human text.
 */
function extractUpstreamMessage(bodyText: string): string | null {
  if (!bodyText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Non-JSON body — return the raw text trimmed to a sensible length.
    const trimmed = bodyText.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const errField = obj['error'];
  const errCode =
    typeof errField === 'string'
      ? errField
      : isObject(errField) && typeof errField['code'] === 'string'
        ? (errField['code'] as string)
        : null;
  const messageText =
    typeof obj['message'] === 'string'
      ? (obj['message'] as string)
      : isObject(errField) && typeof errField['message'] === 'string'
        ? (errField['message'] as string)
        : null;
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
 * Embeds the status filter (or `all` when omitted) plus the current
 * UTC date so concurrent exports don't collide in the browser's
 * downloads folder. Sanitises the status value so a hostile filter
 * string can't inject path separators or quote chars into the
 * `Content-Disposition` header.
 */
function buildDefaultExportFilename(status: string | undefined): string {
  const sanitised = (status ?? 'all').replace(/[^a-z0-9_]/gi, '_').slice(0, 32);
  const date = new Date().toISOString().slice(0, 10);
  return `aggregator-dashboard-${sanitised}-${date}.csv`;
}
