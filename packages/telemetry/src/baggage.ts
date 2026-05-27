/**
 * Aggregator / request-id Baggage helpers.
 *
 * `propagation.setBaggage(ctx, b)` returns a NEW context — it does not
 * mutate the active context. To make the new baggage visible to OTel's
 * propagator on the outbound side, the helper must enter the new context
 * for the duration of a callback via `context.with`. The pattern is
 * therefore wrapper-based.
 *
 * Each helper also stamps the value onto the currently active span as an
 * attribute (which is guaranteed visible in this trace regardless of
 * baggage propagation).
 *
 * @module @aggregator-dpg/telemetry/baggage
 * @package @aggregator-dpg/telemetry
 */

import { context, propagation, trace } from '@opentelemetry/api';

const AGG_KEY = 'aggregator_id';
const REQ_ID_KEY = 'x_request_id';

/**
 * Runs `fn` inside a context where `aggregator_id` is set as a Baggage
 * entry, so downstream HTTP / BullMQ outbound calls carry it via the
 * W3C Baggage propagator. Also stamps it on the active span.
 *
 * @param aggregatorId - The aggregator identifier to propagate.
 * @param fn - Callback to run within the new baggage context.
 * @returns The return value of `fn`.
 */
export async function withAggregatorBaggage<T>(
  aggregatorId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const span = trace.getSpan(context.active());
  span?.setAttribute('aggregator_id', aggregatorId);
  const baggage = propagation.getBaggage(context.active()) ?? propagation.createBaggage();
  const next = baggage.setEntry(AGG_KEY, { value: aggregatorId });
  const ctx = propagation.setBaggage(context.active(), next);
  return context.with(ctx, fn);
}

/**
 * Runs `fn` inside a context where `x_request_id` is set as a Baggage
 * entry, so downstream HTTP / BullMQ outbound calls carry it via the
 * W3C Baggage propagator. Also stamps it on the active span.
 *
 * @param requestId - The HTTP request identifier (e.g. from `x-request-id` header).
 * @param fn - Callback to run within the new baggage context.
 * @returns The return value of `fn`.
 */
export async function withRequestIdBaggage<T>(
  requestId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const span = trace.getSpan(context.active());
  span?.setAttribute('http.request_id', requestId);
  const baggage = propagation.getBaggage(context.active()) ?? propagation.createBaggage();
  const next = baggage.setEntry(REQ_ID_KEY, { value: requestId });
  const ctx = propagation.setBaggage(context.active(), next);
  return context.with(ctx, fn);
}

/**
 * Reads the `aggregator_id` entry from the active OTel baggage context.
 *
 * Returns `undefined` if no aggregator ID has been set on the current context,
 * which indicates the request did not originate from an aggregator-aware entry
 * point or the baggage was not propagated correctly.
 *
 * @returns The aggregator ID string, or `undefined` when unset.
 */
export function getAggregatorId(): string | undefined {
  return propagation.getBaggage(context.active())?.getEntry(AGG_KEY)?.value;
}
