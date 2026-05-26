/**
 * Public testing subpath for `@aggregator-dpg/telemetry`.
 *
 * Cross-package tests should import `TelemetryFake` and helpers from here,
 * never from `in-memory.ts` directly. This follows the repository convention
 * that external consumers must go through the `./testing` subpath export so
 * the public contract is enforced at the package boundary.
 *
 * Usage:
 * ```ts
 * import { TelemetryFake, buildSpanFixture } from '@aggregator-dpg/telemetry/testing';
 *
 * const fake = new TelemetryFake();
 * fake.recordSpan(buildSpanFixture({ name: 'my.operation' }));
 * expect(fake.spans).toHaveLength(1);
 * ```
 *
 * @module @aggregator-dpg/telemetry/testing
 */

import type { SpanFixture } from './in-memory.js';

export { InMemoryTelemetry as TelemetryFake } from './in-memory.js';
export type { SpanFixture, MetricFixture } from './in-memory.js';

/**
 * Builds a valid `SpanFixture` with sensible defaults for use in tests.
 *
 * Provides stable, deterministic defaults so test snapshots remain
 * reproducible. Override only the fields relevant to the test case.
 *
 * @param overrides - Partial fields to merge over the defaults.
 * @returns A complete `SpanFixture` ready for seeding or direct assertion.
 *
 * @example
 * ```ts
 * const span = buildSpanFixture({ name: 'api.request', attributes: { route: '/health' } });
 * // { name: 'api.request', attributes: { route: '/health' } }
 * ```
 */
export function buildSpanFixture(overrides: Partial<SpanFixture> = {}): SpanFixture {
  return {
    name: 'test.span',
    attributes: {},
    ...overrides,
  };
}
