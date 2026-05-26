/**
 * HTTP auto-instrumentation registration for Fastify (inbound) and undici (outbound).
 *
 * Patches the global OTel provider so that every Fastify request handler and
 * every outbound fetch/undici call is automatically wrapped in a span without
 * any per-route code changes.
 *
 * @module @aggregator-dpg/telemetry/http
 * @package @aggregator-dpg/telemetry
 */

import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

let registered = false;

/**
 * Registers Fastify (inbound) and undici (outbound fetch) auto-instrumentation
 * with the global OTel provider.
 *
 * Must be called *after* `bootTelemetry()` so the trace/metric providers exist
 * when the instrumentation patches install themselves. Calling this function
 * more than once is a no-op — the module-level `registered` flag prevents
 * re-registration, which would otherwise install duplicate span handlers and
 * double-count requests.
 */
export function registerHttpInstrumentations(): void {
  if (registered) return;
  registerInstrumentations({
    instrumentations: [new FastifyInstrumentation(), new UndiciInstrumentation()],
  });
  registered = true;
}
