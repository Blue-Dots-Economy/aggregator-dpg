/**
 * Fire-and-forget outcome event client for apps/observability-svc.
 *
 * Until OBS_SVC_URL is set this is a no-op; producers can wire emit
 * calls today and the Phase 4 cutover is a config flip. HMAC-SHA256
 * over `(timestamp + body)` per design §12.2. Never raises — failures
 * are silently dropped (caller increments a local counter on .catch()
 * per design §11.3).
 *
 * @module @aggregator-dpg/telemetry/outcomes
 * @package @aggregator-dpg/telemetry
 */

import { createHmac } from 'node:crypto';

/**
 * Configuration for the outcomes event client.
 *
 * All fields are optional; omitting `outcomesSvcUrl`, `hmacKeyId`, or
 * `hmacSecret` leaves the client in no-op mode.
 */
interface OutcomesConfig {
  /** Base URL of the observability service (e.g. `http://observability-svc:8080`). */
  outcomesSvcUrl?: string;
  /** Identifier of the HMAC key sent in `X-Outcome-Key-Id`. */
  hmacKeyId?: string;
  /** HMAC-SHA256 secret used to sign the request body. */
  hmacSecret?: string;
  /** Overrides the global `fetch` — injected in tests to avoid real network calls. */
  fetchImpl?: typeof fetch;
}

let cfg: OutcomesConfig = {};

/**
 * Replaces the module-level outcomes configuration.
 *
 * Call once at application bootstrap. In tests, pass `fetchImpl` to
 * intercept HTTP calls without making real network requests.
 *
 * @param next - New configuration to apply.
 */
export function configureOutcomes(next: OutcomesConfig): void {
  cfg = next;
}

/**
 * Payload for a turn (conversation round-trip) outcome event.
 */
export interface TurnPayload {
  /** Event name identifying the turn type (e.g. `participant.created`). */
  event: string;
  /** Idempotency key preventing duplicate processing on the receiver. */
  idempotency_key: string;
  /** Arbitrary key-value metadata attached to the event. */
  attributes: Record<string, unknown>;
  /** Optional list of tool calls made during the turn. */
  tool_calls?: unknown[];
  /** Optional per-step latency measurements in milliseconds. */
  latencies?: Record<string, number>;
  /** Optional token usage counters. */
  tokens?: Record<string, number>;
}

/**
 * Payload for a discrete signal outcome event.
 */
export interface SignalPayload {
  /** Signal name (e.g. `drop`, `retry`). */
  name: string;
  /** Idempotency key preventing duplicate processing on the receiver. */
  idempotency_key: string;
  /** Arbitrary key-value metadata attached to the event. */
  attributes: Record<string, unknown>;
}

/**
 * Emits a turn outcome event to the observability service.
 *
 * Fire-and-forget — never throws. If the service is unreachable or
 * `outcomesSvcUrl` is unset, the call is silently dropped.
 *
 * @param payload - Turn event data to send.
 */
export async function emitTurn(payload: TurnPayload): Promise<void> {
  return post('/emit/turn', payload);
}

/**
 * Emits a signal outcome event to the observability service.
 *
 * Fire-and-forget — never throws. If the service is unreachable or
 * `outcomesSvcUrl` is unset, the call is silently dropped.
 *
 * @param payload - Signal event data to send.
 */
export async function emitSignal(payload: SignalPayload): Promise<void> {
  return post('/emit/signal', payload);
}

/**
 * Sends a POST request to the observability service with HMAC-SHA256 signing.
 *
 * Returns immediately without error if the client is unconfigured. Any network
 * or HTTP error is swallowed per design §11.3.
 *
 * @param path - URL path to POST to (e.g. `/emit/turn`).
 * @param payload - JSON-serialisable body to send.
 */
async function post(path: string, payload: object): Promise<void> {
  if (!cfg.outcomesSvcUrl || !cfg.hmacKeyId || !cfg.hmacSecret) return;
  const body = JSON.stringify(payload);
  const ts = Date.now().toString();
  const sig = createHmac('sha256', cfg.hmacSecret)
    .update(ts + body)
    .digest('hex');
  const doFetch = cfg.fetchImpl ?? fetch;
  try {
    await doFetch(`${cfg.outcomesSvcUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Outcome-Key-Id': cfg.hmacKeyId,
        'X-Outcome-Signature': sig,
        'X-Outcome-Timestamp': ts,
      },
      body,
    });
  } catch {
    /* swallow per §11.3 — caller increments a local counter on .catch() */
  }
}
