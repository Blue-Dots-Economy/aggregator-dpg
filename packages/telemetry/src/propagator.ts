/**
 * W3C context propagator configuration for @aggregator-dpg/telemetry.
 *
 * Installs the composite W3C propagator that reads and writes both the
 * `traceparent` and `baggage` HTTP headers, enabling trace linkage and
 * cross-service key/value context across all aggregator services, per the
 * propagation requirements in docs/telemetry-design.md §5.1.
 *
 * @module @aggregator-dpg/telemetry/propagator
 */

import { propagation } from '@opentelemetry/api';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';

/**
 * Installs the global OTel context propagator for the aggregator platform.
 *
 * Registers a {@link CompositePropagator} that combines:
 * - {@link W3CTraceContextPropagator} — reads/writes the `traceparent` header
 *   so that span context flows across service boundaries without gaps in traces.
 * - {@link W3CBaggagePropagator} — reads/writes the `baggage` header so that
 *   DPG-scoped keys (e.g. `aggregator_id`, `network_id`) are propagated
 *   transparently into every downstream service and sampler.
 *
 * Call once at process startup, before any OTel SDK is configured.  The
 * function is idempotent — calling it multiple times within the same process
 * replaces the previously registered propagator with an equivalent one, which
 * is safe for tests that call it repeatedly.
 */
export function configurePropagator(): void {
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );
}
