/**
 * BullMQ producer/consumer telemetry helpers.
 *
 * BullMQ has no native OTel hook. We carry the W3C traceparent inside
 * `job.data._otel`, set on enqueue, extracted on dequeue. This stitches
 * api producer spans to worker consumer spans across the Redis boundary.
 *
 * @module @aggregator-dpg/telemetry/bullmq
 * @package @aggregator-dpg/telemetry
 */

import {
  context,
  propagation,
  trace,
  SpanStatusCode,
  type Context,
  type Span,
} from '@opentelemetry/api';
import type { JobsOptions } from 'bullmq';

/**
 * Minimal structural interface for a BullMQ Queue as seen by this module.
 *
 * Using a structural type rather than `Queue<T>` directly avoids complex
 * BullMQ generic constraints (`ExtractNameType`) that are not relevant to
 * trace propagation.
 */
interface QueueLike<T> {
  add(name: string, data: T, opts?: JobsOptions): Promise<unknown>;
}

/**
 * Marker interface for job data that carries an OTel W3C trace carrier.
 *
 * The `_otel` field is injected by {@link addJobWithTrace} at enqueue time
 * and consumed by {@link extractJobContext} at dequeue time.
 */
export interface JobWithCarrier {
  /** W3C trace context carrier, e.g. `{ traceparent: '00-...', baggage: '...' }`. */
  _otel?: Record<string, string>;
}

/**
 * Enqueues a BullMQ job with the current OTel trace context injected into
 * the job payload's `_otel` field.
 *
 * Use this instead of calling `queue.add()` directly in api/worker producers
 * so that the worker consumer can link its span to the producing span via
 * {@link wrapWorker}.
 *
 * @param queue - The BullMQ Queue instance to enqueue onto.
 * @param name - The job name / event key.
 * @param data - The job payload. Must be a plain object.
 * @param opts - Optional BullMQ job options (delay, priority, etc.).
 * @returns The created BullMQ Job instance (as returned by `queue.add`).
 */
export async function addJobWithTrace<T extends object>(
  queue: QueueLike<T>,
  name: string,
  data: T,
  opts?: JobsOptions,
): Promise<unknown> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return queue.add(name, { ...data, _otel: carrier } as T, opts);
}

/**
 * Extracts the OTel parent context from a BullMQ job payload.
 *
 * Returns a context derived from the W3C carrier stored in `data._otel`.
 * Falls back to the currently active context when the carrier is absent or
 * empty (e.g. jobs enqueued without {@link addJobWithTrace}).
 *
 * @param data - The raw job data as received by the BullMQ Worker processor.
 * @returns The OTel {@link Context} to use as the parent for worker spans.
 */
export function extractJobContext<T>(data: T & JobWithCarrier): Context {
  const carrier = (data as JobWithCarrier)._otel ?? {};
  if (Object.keys(carrier).length === 0) return context.active();
  return propagation.extract(context.active(), carrier);
}

/**
 * Wraps a BullMQ worker handler in a child OTel span linked to the producer.
 *
 * Extracts the parent context from `data._otel`, starts a
 * `worker.<queueName>.process` span as its child, runs `handler`, and
 * finalises the span (recording exceptions and setting error status on
 * failure).
 *
 * @param queueName - The queue name; used to name the worker span.
 * @param data - The job payload, potentially carrying `_otel` carrier fields.
 * @param handler - Async function to run inside the span. Receives the active
 *   span so it can add attributes or events.
 * @returns The return value of `handler`.
 * @throws Re-throws any error thrown by `handler` after recording it on the span.
 */
export async function wrapWorker<T>(
  queueName: string,
  data: T & JobWithCarrier,
  handler: (span: Span) => Promise<unknown>,
): Promise<unknown> {
  const parent = extractJobContext(data);
  const tracer = trace.getTracer('@aggregator-dpg/telemetry');
  return context.with(parent, () =>
    tracer.startActiveSpan(`worker.${queueName}.process`, async (span) => {
      try {
        return await handler(span);
      } catch (e) {
        span.recordException(e as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw e;
      } finally {
        span.end();
      }
    }),
  );
}
