/**
 * Tests for BullMQ trace propagation helpers.
 *
 * Registers a BasicTracerProvider in beforeAll so that trace.getTracer()
 * returns a real tracer capable of generating valid trace IDs. Using
 * beforeAll/afterAll (with trace.disable()) scopes the provider to this file
 * and avoids occupying the global OTel TracerProvider slot before
 * bootstrap.test.ts runs (OTel uses allowOverride=false).
 *
 * @module @aggregator-dpg/telemetry/tests/bullmq.test
 * @package @aggregator-dpg/telemetry
 */

import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { context, propagation, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { addJobWithTrace, extractJobContext, wrapWorker } from '../bullmq.js';

const provider = new BasicTracerProvider();

beforeAll(() => {
  provider.register();
});

afterAll(() => {
  trace.disable();
});

/**
 * Helper: injects the current OTel context into a carrier object without
 * calling queue.add. Used to build a populated _otel carrier for extraction
 * tests without needing a real queue instance.
 */
function injectToCarrier(carrier: Record<string, string>): void {
  propagation.inject(context.active(), carrier);
}

describe('addJobWithTrace', () => {
  it('injects an _otel carrier into the job payload', async () => {
    const add = vi.fn().mockResolvedValue({ id: 'job-1' });
    const queue = { add } as never;
    const tracer = trace.getTracer('t');
    const span = tracer.startSpan('producer');
    await context.with(trace.setSpan(ROOT_CONTEXT, span), () =>
      addJobWithTrace(queue, 'process', { foo: 1 } as never),
    );
    span.end();
    const payload = add.mock.calls[0][1];
    expect(payload._otel).toBeDefined();
    expect(typeof payload._otel.traceparent).toBe('string');
    expect(payload.foo).toBe(1);
  });
});

describe('extractJobContext', () => {
  it('returns the active context when payload has no _otel', () => {
    const ctx = extractJobContext({});
    expect(ctx).toBe(context.active());
  });

  it('extracts a real parent context from a populated carrier', () => {
    const tracer = trace.getTracer('t');
    const parentSpan = tracer.startSpan('producer');
    const carrier: Record<string, string> = {};
    context.with(trace.setSpan(ROOT_CONTEXT, parentSpan), () => {
      injectToCarrier(carrier);
    });
    parentSpan.end();

    const ctx = extractJobContext({ _otel: carrier });
    // The extracted context should carry a remote span context with the
    // producer's trace ID so that the worker span becomes its child.
    const remoteSpan = trace.getSpan(ctx);
    expect(remoteSpan).toBeDefined();
    expect(remoteSpan!.spanContext().traceId).toBe(parentSpan.spanContext().traceId);
  });
});

describe('wrapWorker', () => {
  it('starts a child span that re-uses the parent trace id', async () => {
    const tracer = trace.getTracer('t');
    const parentSpan = tracer.startSpan('producer');
    const carrier: Record<string, string> = {};
    await context.with(trace.setSpan(ROOT_CONTEXT, parentSpan), async () => {
      injectToCarrier(carrier);
    });
    parentSpan.end();
    const parentTraceId = parentSpan.spanContext().traceId;

    let observedTraceId = '';
    await wrapWorker('test-queue', { _otel: carrier } as never, async (span) => {
      observedTraceId = span.spanContext().traceId;
      return undefined;
    });
    expect(observedTraceId).toBe(parentTraceId);
  });

  it('re-throws errors from the handler', async () => {
    await expect(
      wrapWorker('q', {} as never, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
