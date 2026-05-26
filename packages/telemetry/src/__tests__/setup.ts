/**
 * Vitest global setup for @aggregator-dpg/telemetry tests.
 *
 * Installs an AsyncLocalStorage-backed OTel context manager so that
 * `context.with()` behaves correctly in the test environment, matching
 * production behaviour where the NodeSDK installs the same context manager
 * at start-up.
 *
 * Also installs the W3C composite propagator globally so that baggage and
 * traceparent headers are handled correctly across all test files.
 *
 * NOTE: BasicTracerProvider is intentionally NOT registered here. OTel uses
 * `allowOverride=false` for the global TracerProvider slot, so registering it
 * here would prevent bootstrap.test.ts from installing the NodeSDK provider.
 * bullmq.test.ts owns its own provider registration via beforeAll/afterAll.
 *
 * No monkeypatching of `propagation.setBaggage` — that was the design flaw
 * that Task 0.9 fixed. The correct OTel pattern is callback-based:
 * use `context.with(newCtx, fn)` instead of mutating the active context.
 *
 * @module @aggregator-dpg/telemetry/tests/setup
 * @package @aggregator-dpg/telemetry
 */

import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';

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
