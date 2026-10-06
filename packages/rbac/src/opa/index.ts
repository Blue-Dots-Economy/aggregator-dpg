/**
 * OPA-backed decision engine (`@aggregator-dpg/rbac`).
 *
 * Asks the OPA sidecar `POST {baseUrl}/v1/data/rbac/decision`. Every call has
 * a timeout and one retry with backoff on transient failures. Any failure is
 * returned as an `UpstreamError`, which callers treat as a deny.
 *
 * @module @aggregator-dpg/rbac/opa
 */

import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { AuthorizerBase, DecisionSchema } from '../interface.js';
import type { Decision, DecisionInput } from '../interface.js';

/** Settings for {@link OpaAuthorizer}. */
export interface OpaAuthorizerOptions {
  /** Sidecar base URL, e.g. `http://localhost:8181`. */
  baseUrl: string;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
  /** Retries after the first attempt, for transient failures. */
  retries: number;
  /** Base backoff in milliseconds; doubles per retry. */
  backoffMs: number;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const DECISION_PATH = '/v1/data/rbac/decision';

/** Whether a failed attempt is worth retrying. */
function isTransient(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

/** Decision engine that queries the OPA sidecar. */
export class OpaAuthorizer extends AuthorizerBase {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  /**
   * Creates an engine bound to one sidecar.
   *
   * @param options - URL, timeout and retry settings.
   */
  constructor(private readonly options: OpaAuthorizerOptions) {
    super();
    this.url = options.baseUrl.replace(/\/+$/, '') + DECISION_PATH;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Answers one access question through OPA.
   *
   * @param input - The access question.
   * @returns Ok with the decision; Err `OPA_UNAVAILABLE` (network, timeout,
   *   5xx after retries), `OPA_REJECTED` (other non-2xx) or `OPA_BAD_RESPONSE`
   *   (no `result`, or a result of the wrong shape, e.g. policy not loaded).
   */
  async decide(input: DecisionInput): Promise<Result<Decision, BaseError>> {
    let lastStatus: number | null = null;
    let lastError = '';
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, this.options.backoffMs * 2 ** (attempt - 1)));
      }
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (e) {
        lastStatus = null;
        lastError = String(e);
        continue;
      }
      if (!res.ok) {
        lastStatus = res.status;
        lastError = `HTTP ${res.status}`;
        if (isTransient(res.status)) continue;
        return err(
          new UpstreamError('OPA rejected the decision request', {
            code: 'OPA_REJECTED',
            details: { status: res.status },
          }),
        );
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch (e) {
        return err(
          new UpstreamError('OPA returned invalid JSON', {
            code: 'OPA_BAD_RESPONSE',
            cause: e,
          }),
        );
      }
      const parsed = DecisionSchema.safeParse((body as { result?: unknown } | null)?.result);
      if (!parsed.success) {
        return err(
          new UpstreamError('OPA returned no decision; is the rbac policy loaded?', {
            code: 'OPA_BAD_RESPONSE',
          }),
        );
      }
      return ok(parsed.data);
    }
    return err(
      new UpstreamError('OPA is unavailable', {
        code: 'OPA_UNAVAILABLE',
        details: { status: lastStatus, error: lastError, attempts: this.options.retries + 1 },
      }),
    );
  }
}
