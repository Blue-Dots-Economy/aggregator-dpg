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

import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
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
  type SignalStackItemList,
  type SignalStackItemQuery,
  type SignalStackOnboardParticipantInput,
  type SignalStackOnboardParticipantResult,
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
    this.endpoint = `${this.baseUrl}/api/v1/admin/onboard_participant`;
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

    const body: Record<string, unknown> = {
      name: input.name,
      terms_accepted: input.terms_accepted,
      privacy_accepted: input.privacy_accepted,
      channel: input.channel,
      source_id: input.source_id,
      network: input.network,
      domain: input.domain,
      item_type: input.item_type,
      profile: input.profile,
    };
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

      const payload = (await res.json()) as SignalStackOnboardParticipantResult;
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.user_id !== 'string' ||
        typeof payload.profile_item_id !== 'string'
      ) {
        return err(
          new UpstreamError('signalstack onboard returned unexpected payload', {
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
        !payload.rollup ||
        !Array.isArray(payload.participants) ||
        !payload.metadata
      ) {
        return err(
          new UpstreamError('signalstack dashboard returned unexpected payload', {
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
