import { describe, expect, it, vi } from 'vitest';
import { context, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import { configurePropagator } from '../propagator.js';
import { addJobWithTrace, extractJobContext } from '../bullmq.js';

configurePropagator();

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
});
