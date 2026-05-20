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
    this.endpoint = `${config.baseUrl.replace(/\/+$/, '')}/api/v1/admin/onboard`;
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
        return err(
          new UpstreamError(`signalstack onboard returned ${res.status}`, {
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
