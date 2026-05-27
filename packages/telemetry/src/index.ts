/**
 * Top-level barrel for @aggregator-dpg/telemetry.
 *
 * Re-exports the public surface used by every aggregator-dpg service
 * (api, worker, web, observability-svc). Internal modules (`resource`,
 * `propagator`, `views`, `pino-otel-transport`) are imported by name
 * by the modules that need them; they are NOT re-exported here.
 *
 * @module @aggregator-dpg/telemetry
 * @package @aggregator-dpg/telemetry
 */

export * from './interface.js';
export { bootTelemetry, shutdownTelemetry, isTelemetryEnabled } from './bootstrap.js';
export { getLogger, resetLoggerForTesting } from './logger.js';
export { withAggregatorBaggage, withRequestIdBaggage, getAggregatorId } from './baggage.js';
export { addJobWithTrace, wrapWorker, extractJobContext } from './bullmq.js';
export { registerHttpInstrumentations } from './http.js';
export { emitTurn, emitSignal, configureOutcomes } from './outcomes.js';
export { emitAudit } from './audit.js';
export type { TurnPayload, SignalPayload } from './outcomes.js';
export type { AuditRecord } from './audit.js';
