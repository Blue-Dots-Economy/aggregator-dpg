/**
 * Process-wide pino instance shared across all aggregator-dpg services.
 *
 * Adds a mixin that captures `trace_id` / `span_id` from the active OTel
 * context AT LOG TIME (in the main thread). The mixin runs synchronously
 * before pino serialises the record, so the trace ids are stamped into
 * the JSON payload that the transport later forwards over OTLP — even
 * when pino runs the transport in a worker thread where the OTel
 * context is unreachable.
 *
 * @module
 * @package @aggregator-dpg/telemetry
 */

import { createRequire } from 'node:module';
import pino, { type Logger, type TransportTargetOptions } from 'pino';
import { context, trace } from '@opentelemetry/api';

/**
 * Resolves the absolute filesystem path to the OTLP pino transport.
 *
 * pino loads transport targets in a worker thread that uses its own module
 * resolution. Subpath exports of workspace packages (e.g.
 * `@aggregator-dpg/telemetry/pino-transport`) don't always resolve correctly
 * in the worker's context, so we resolve once on the main thread and hand
 * pino an absolute path it can `require()` directly.
 */
function resolvePinoTransportPath(): string {
  const req = createRequire(import.meta.url);
  return req.resolve('@aggregator-dpg/telemetry/pino-transport');
}

/**
 * Pino redact paths applied to every log record.
 *
 * Prevents credentials, session tokens, and cookie values from appearing in
 * structured log output or OTLP exports.
 */
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

/**
 * Options for constructing the process-wide logger singleton.
 *
 * Only the first call to `getLogger()` uses these options; subsequent calls
 * return the cached instance regardless of the arguments passed.
 */
export interface LoggerOptions {
  /** Logical service name stamped into every log record as `service`. */
  serviceName: string;
  /** Deployment environment stamped into every log record as `env`. */
  env: string;
  /**
   * Minimum log level.  Defaults to `'info'` when omitted.
   * Respects the `LOG_LEVEL` convention described in the observability rules.
   */
  level?: string;
  /**
   * Additional PII field paths to forward to the OTLP transport's exclusion
   * list.  The transport strips these before emitting log body to the
   * collector.  Defaults to `[]`.
   */
  piiFieldsExcluded?: string[];
  /**
   * When `true`, attaches the `@aggregator-dpg/telemetry/pino-transport`
   * target so log records are forwarded to the OTLP log exporter.
   */
  otlpEnabled?: boolean;
}

/** Cached singleton.  Reset only via `resetLoggerForTesting()`. */
let singleton: Logger | undefined;

/**
 * Returns the process-wide pino logger singleton.
 *
 * Creates the instance on the first call using `opts`; every subsequent call
 * ignores `opts` and returns the cached instance.  This ensures a single pino
 * instance is shared across all modules in the process, which is required for
 * consistent `base` fields, unified redact paths, and a single transport chain.
 *
 * The returned logger stamps `trace_id` and `span_id` from the active OTel
 * span context via a synchronous mixin that runs on the main thread at log
 * time.  The OTLP transport (Task 0.7) picks these up when it serialises the
 * record in its worker thread.
 *
 * @param opts - Configuration for the singleton.  Only used on the first call.
 * @returns The shared pino `Logger` instance.
 */
export function getLogger(opts: LoggerOptions): Logger {
  if (singleton) return singleton;

  const targets: TransportTargetOptions[] = [];

  if (opts.env === 'development') {
    targets.push({
      target: 'pino-pretty',
      level: opts.level ?? 'info',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        singleLine: false,
        ignore: 'pid,hostname,service,env',
      },
    });
  } else {
    targets.push({ target: 'pino/file', level: opts.level ?? 'info', options: { destination: 1 } });
  }

  if (opts.otlpEnabled) {
    try {
      targets.push({
        target: resolvePinoTransportPath(),
        level: opts.level ?? 'info',
        options: { piiFieldsExcluded: opts.piiFieldsExcluded ?? [] },
      });
    } catch {
      // If the transport can't be resolved (e.g., wrong install layout in a
      // worker container), skip OTLP log forwarding. Logs still reach stdout
      // via the pino-pretty or pino/file target above, and traces + metrics
      // are unaffected. Better degraded than refusing to boot.
    }
  }

  singleton = pino({
    level: opts.level ?? 'info',
    base: { service: opts.serviceName, env: opts.env },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    mixin: () => {
      const span = trace.getSpan(context.active());
      if (!span) return {};
      const ctx = span.spanContext();
      return { trace_id: ctx.traceId, span_id: ctx.spanId };
    },
    transport: { targets },
  });

  return singleton;
}

/**
 * Clears the singleton so `getLogger()` will construct a fresh instance on
 * the next call.
 *
 * **Test-only.**  Must not be called in production paths.  Needed because
 * tests configure the logger differently (e.g., no OTLP target) and the
 * module-level singleton persists across test cases in the same process.
 */
export function resetLoggerForTesting(): void {
  singleton = undefined;
}
