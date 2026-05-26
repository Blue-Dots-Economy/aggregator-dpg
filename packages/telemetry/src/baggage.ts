/**
 * Aggregator / request-id Baggage helpers.
 *
 * These functions stamp ids onto the active span (guaranteed to appear in
 * the current trace) AND best-effort update active OTel baggage so the
 * Composite propagator (W3C TraceContext + Baggage) carries the entries
 * through outbound HTTP and BullMQ.
 *
 * Note: OTel JS treats baggage as part of an immutable Context. Calling
 * `propagation.setBaggage(ctx, b)` returns a new context — to make it
 * the active context for the remainder of the current async chain, the
 * surrounding code must already be inside a `context.with` block or use
 * an AsyncHooksContextManager (which the NodeSDK installs by default).
 * For Fastify and BullMQ auto-instrumentation, the active context is
 * managed for us; calling these helpers inside a request/job handler
 * mutates the active context correctly.
 *
 * @module @aggregator-dpg/telemetry/baggage
 * @package @aggregator-dpg/telemetry
 */

import { context, propagation, trace } from '@opentelemetry/api';

const AGG_KEY = 'aggregator_id';
const REQ_ID_KEY = 'x_request_id';

/**
 * Stamps the given aggregator ID onto the active span as an attribute and
 * best-effort updates active OTel baggage so the value is propagated to
 * downstream services via the W3C `baggage` header.
 *
 * @param aggregatorId - The aggregator identifier to propagate.
 */
export function setAggregatorBaggage(aggregatorId: string): void {
  const span = trace.getSpan(context.active());
  span?.setAttribute('aggregator_id', aggregatorId);

  const baggage = propagation.getBaggage(context.active()) ?? propagation.createBaggage();
  const next = baggage.setEntry(AGG_KEY, { value: aggregatorId });
  propagation.setBaggage(context.active(), next);
}

/**
 * Stamps the given request ID onto the active span as an attribute and
 * best-effort updates active OTel baggage so the value is propagated to
 * downstream services via the W3C `baggage` header.
 *
 * @param requestId - The HTTP request identifier (e.g. from `x-request-id` header).
 */
export function setRequestIdBaggage(requestId: string): void {
  const span = trace.getSpan(context.active());
  span?.setAttribute('http.request_id', requestId);

  const baggage = propagation.getBaggage(context.active()) ?? propagation.createBaggage();
  const next = baggage.setEntry(REQ_ID_KEY, { value: requestId });
  propagation.setBaggage(context.active(), next);
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
