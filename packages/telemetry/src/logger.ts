/**
 * Process-wide pino instance shared across all aggregator-dpg services.
 *
 * Architecture:
 * - pino runs in the MAIN thread (no worker transport) so we can call into
 *   the OTel API (`logs.getLogger().emit(...)`) directly. Worker-thread
 *   transports have an isolated `@opentelemetry/api-logs` global that
 *   defaults to NoopLoggerProvider — `setGlobalLoggerProvider()` only
 *   reaches the main-thread global, so worker logs would silently disappear.
 * - For development (`env === 'development'`), pino-pretty is the destination.
 * - Otherwise, JSON records go to stdout AND to a custom OTel-bridge writable
 *   that forwards each record to the OTLP logs pipeline.
 * - A mixin captures `trace_id` / `span_id` from the active OTel context at
 *   log time, so the trace correlation is stamped synchronously before the
 *   record is serialised.
 *
 * @module
 * @package @aggregator-dpg/telemetry
 */

import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import { context, trace } from '@opentelemetry/api';
import {
  logs,
  SeverityNumber,
  type AnyValueMap,
  type Logger as OtelLogger,
} from '@opentelemetry/api-logs';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  'body.password',
  'body.token',
];

const PINO_TO_OTEL_SEVERITY: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};

const PINO_LEVEL_LABELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/**
 * Returns a Writable that parses each pino JSON record and forwards it to
 * the active OTel LoggerProvider on the main thread. Drops records silently
 * on parse failure or when the LoggerProvider hasn't been installed yet —
 * stdout still receives the original record via the parallel stream.
 */
function createOtelBridgeStream(piiExcluded: ReadonlyArray<string>): Writable {
  let otelLoggerCache: OtelLogger | undefined;
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const rec = JSON.parse(text) as Record<string, unknown>;
        if (!otelLoggerCache) otelLoggerCache = logs.getLogger('pino');
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
          attrs[k] = piiExcluded.includes(k)
            ? '[REDACTED]'
            : (v as AnyValueMap[string] | undefined);
        }

        otelLoggerCache.emit({
          severityNumber: PINO_TO_OTEL_SEVERITY[level] ?? SeverityNumber.INFO,
          severityText: PINO_LEVEL_LABELS[level] ?? String(level),
          ...(msg !== undefined && { body: msg }),
          timestamp: time,
          attributes: attrs,
        });
      } catch {
        // Bridge is best-effort. Never fail the log pipeline.
      }
      callback();
    },
  });
}

interface LoggerOptions {
  serviceName: string;
  env: string;
  level?: string;
  piiFieldsExcluded?: string[];
  otlpEnabled?: boolean;
}

let singleton: Logger | undefined;

export function getLogger(opts: LoggerOptions): Logger {
  if (singleton) return singleton;

  const piiExcluded = opts.piiFieldsExcluded ?? [];

  const mixin = (): Record<string, unknown> => {
    const span = trace.getSpan(context.active());
    if (!span) return {};
    const ctx = span.spanContext();
    return { trace_id: ctx.traceId, span_id: ctx.spanId };
  };

  // In development, fall back to pino-pretty for human-readable stdout.
  // pino-pretty is itself a transport; we don't want to mix worker transports
  // with main-thread multistream, so dev mode uses pretty-only and skips
  // the OTel bridge (devs typically don't run Loki anyway).
  if (opts.env === 'development') {
    singleton = pino({
      level: opts.level ?? 'info',
      base: { service: opts.serviceName, env: opts.env },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      mixin,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          singleLine: false,
          ignore: 'pid,hostname,service,env',
        },
      },
    });
    return singleton;
  }

  // Production: write JSON to stdout AND OTel logs in parallel via multistream.
  const streams = [
    { stream: process.stdout },
    ...(opts.otlpEnabled ? [{ stream: createOtelBridgeStream(piiExcluded) }] : []),
  ];

  singleton = pino(
    {
      level: opts.level ?? 'info',
      base: { service: opts.serviceName, env: opts.env },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      mixin,
    },
    pino.multistream(streams),
  );

  return singleton;
}

export function resetLoggerForTesting(): void {
  singleton = undefined;
}
