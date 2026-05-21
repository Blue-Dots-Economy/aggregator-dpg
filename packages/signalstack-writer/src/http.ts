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
  type SignalStackItemList,
  type SignalStackItemQuery,
  type SignalStackOnboardInput,
  type SignalStackOnboardResult,
} from './interface.js';

export interface HttpSignalStackWriterConfig {
  /** Base URL of the signalstack API, e.g. `http://localhost:2743`. No trailing slash. */
  baseUrl: string;
  /** Admin api-key issued by signalstack via better-auth. Sent as `x-api-key`. */
  apiKey: string;
  /** Optional override; defaults to global `fetch`. Lets tests inject a stub. */
  fetchImpl?: typeof fetch;
  /** Optional request timeout in ms; off by default. */
  timeoutMs?: number;
}

export class HttpSignalStackWriter extends SignalStackWriterBase {
  private readonly baseUrl: string;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
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
    this.endpoint = `${this.baseUrl}/api/v1/admin/onboard`;
    this.headers = {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
    };
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs;
  }

  override async onboard(
    input: SignalStackOnboardInput,
  ): Promise<Result<SignalStackOnboardResult, BaseError>> {
    const guardErr = this.guardInput(input);
    if (guardErr) return err(guardErr);

    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(input),
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

      const payload = (await res.json()) as SignalStackOnboardResult;
      if (!payload || typeof payload !== 'object' || !payload.user) {
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

  private guardInput(input: SignalStackOnboardInput): BaseError | null {
    if (!input?.user?.name) {
      return new UpstreamError('user.name is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    const hasEmail = Boolean(input.user.email);
    const hasPhone = Boolean(input.user.phoneNumber);
    if (!hasEmail && !hasPhone) {
      return new UpstreamError('either user.email or user.phoneNumber is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    if (input.profile) {
      if (!input.profile.item_network || !input.profile.item_domain || !input.profile.item_type) {
        return new UpstreamError('profile requires item_network, item_domain, and item_type', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        });
      }
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
