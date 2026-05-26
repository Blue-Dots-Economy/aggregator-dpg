/**
 * Vitest global setup for @aggregator-dpg/telemetry tests.
 *
 * Installs an AsyncLocalStorage-backed OTel context manager so that
 * `context.with()` behaves correctly in the test environment, matching
 * production behaviour where the NodeSDK installs the same context manager
 * at start-up.
 *
 * Also registers a BasicTracerProvider so that `trace.getTracer()` returns a
 * real tracer capable of generating valid trace IDs, enabling span-context
 * propagation tests (e.g. bullmq.test.ts) to assert on injected traceparent
 * headers without booting the full SDK.
 *
 * No monkeypatching of `propagation.setBaggage` — that was the design flaw
 * that Task 0.9 fixed. The correct OTel pattern is callback-based:
 * use `context.with(newCtx, fn)` instead of mutating the active context.
 *
 * @module @aggregator-dpg/telemetry/tests/setup
 * @package @aggregator-dpg/telemetry
 */

import { context, propagation, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';

const als = new AsyncLocalStorage<typeof ROOT_CONTEXT>();

const contextManager = {
  active(): typeof ROOT_CONTEXT {
    return (als.getStore() as typeof ROOT_CONTEXT | undefined) ?? ROOT_CONTEXT;
  },
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: typeof ROOT_CONTEXT,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const cb = (thisArg == null ? fn : fn.bind(thisArg)) as (...a: A) => ReturnType<F>;
    return als.run(ctx as unknown as typeof ROOT_CONTEXT, cb, ...args);
  },
  bind<T>(_ctx: typeof ROOT_CONTEXT, fn: T): T {
    return fn;
  },
  enable() {
    return this;
  },
  disable() {
    als.disable();
    return this;
  },
};

// Install the context manager globally before any test runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
context.setGlobalContextManager(contextManager as any);

// Install the W3C composite propagator so baggage and traceparent headers
// are handled correctly (same as configurePropagator() in production).
propagation.setGlobalPropagator(
  new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  }),
);

// Register a real TracerProvider so that trace.getTracer() returns a tracer
// that generates valid trace IDs. Without this, spans are no-op and
// propagation.inject() produces an empty carrier (no traceparent header).
const provider = new BasicTracerProvider();
trace.setGlobalTracerProvider(provider);
