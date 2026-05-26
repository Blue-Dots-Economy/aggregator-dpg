/**
 * Pino transport that forwards log records to the active OTel LoggerProvider.
 *
 * This module belongs to the `@aggregator-dpg/telemetry` package.
 *
 * Application code logs via pino as usual. This transport may run in a pino
 * worker thread, where the main-thread OTel context (active span) is
 * unreachable. Therefore the transport does NOT call `trace.getActiveSpan()`.
 * Instead, `trace_id` and `span_id` are injected into each record by a pino
 * mixin (see `logger.ts`) that runs on the main thread at log time. This
 * transport simply forwards those pre-stamped id strings as OTel log record
 * attributes, keeping worker-thread-safe operation.
 */

import build from 'pino-abstract-transport';
import {
  logs,
  SeverityNumber,
  type AnyValueMap,
  type Logger as OtelLogger,
} from '@opentelemetry/api-logs';

/** Maps pino numeric levels to OTel SeverityNumber constants. */
const PINO_TO_OTEL_SEVERITY: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};

/** Maps pino numeric levels to their human-readable label strings. */
const PINO_LEVEL_LABELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/**
 * Converts a single pino log record to an OTel log record and emits it.
 *
 * `trace_id` and `span_id` are forwarded from the record fields to
 * `attributes` rather than resolved from active OTel context. This keeps the
 * function safe to call from a pino worker thread (no shared context).
 *
 * @param rec - Raw pino log record including `level`, `time`, `msg`, and any
 *   additional structured fields.
 * @param logger - OTel Logger whose `emit()` method receives the converted
 *   record.
 * @param piiExcluded - List of attribute key names whose values should be
 *   replaced with `'[REDACTED]'` before forwarding.
 */
export function handleRecord(
  rec: Record<string, unknown>,
  logger: OtelLogger,
  piiExcluded: string[] = [],
): void {
  const {
    level,
    time,
    msg,
    hostname: _hostname,
    pid: _pid,
    ...rest
  } = rec as {
    level: number;
    time: number;
    msg?: string;
    hostname?: string;
    pid?: number;
  } & Record<string, unknown>;

  const attrs: AnyValueMap = {};
  for (const [k, v] of Object.entries(rest)) {
    attrs[k] = piiExcluded.includes(k) ? '[REDACTED]' : (v as AnyValueMap[string]);
  }

  logger.emit({
    severityNumber: PINO_TO_OTEL_SEVERITY[level] ?? SeverityNumber.INFO,
    severityText: PINO_LEVEL_LABELS[level] ?? String(level),
    ...(msg !== undefined && { body: msg }),
    timestamp: time,
    attributes: attrs,
  });
}

/**
 * Creates a pino transport that forwards all log records to the OTel
 * LoggerProvider registered via `logs.getLogger()`.
 *
 * Use this as a pino destination in the transport configuration. The transport
 * supports running in a worker thread — trace context is read from pre-stamped
 * `trace_id` / `span_id` fields on each record, not from the active OTel span.
 *
 * @param opts.piiFieldsExcluded - Attribute keys whose values will be
 *   replaced with `'[REDACTED]'` in the forwarded OTel log record.
 * @returns A pino-compatible writable stream that routes records to OTel.
 */
export default function pinoOtelTransport(opts: { piiFieldsExcluded?: string[] } = {}) {
  return build(async (source) => {
    const logger = logs.getLogger('pino');
    for await (const rec of source) {
      handleRecord(rec, logger, opts.piiFieldsExcluded ?? []);
    }
  });
}
