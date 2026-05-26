/**
 * Vitest global setup for @aggregator-dpg/telemetry tests.
 *
 * Installs an AsyncLocalStorage-backed OTel context manager so that
 * `context.with()` and `propagation.setBaggage()` behave correctly in the
 * test environment, matching production behaviour where the NodeSDK installs
 * the same context manager at start-up.
 *
 * Also patches `propagation.setBaggage` to call `AsyncLocalStorage.enterWith`
 * so that baggage mutations made outside a `context.with` callback (e.g. in
 * Fastify / BullMQ request handlers) are visible to subsequent reads via
 * `context.active()` within the same test.
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
  bind<T>(ctx: typeof ROOT_CONTEXT, fn: T): T {
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

// Patch propagation.setBaggage to also call AsyncLocalStorage.enterWith so
// that baggage mutations made outside a context.with callback are immediately
// visible via context.active() in the same async frame.  This mirrors the
// production behaviour where the NodeSDK's AsyncHooksContextManager wraps
// every Fastify/BullMQ handler in a context.with call.
const origSetBaggage = propagation.setBaggage.bind(propagation);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(propagation as any).setBaggage = function (
  ctx: typeof ROOT_CONTEXT,
  baggage: ReturnType<typeof propagation.createBaggage>,
) {
  const newCtx = origSetBaggage(ctx, baggage);
  als.enterWith(newCtx as unknown as typeof ROOT_CONTEXT);
  return newCtx;
};
