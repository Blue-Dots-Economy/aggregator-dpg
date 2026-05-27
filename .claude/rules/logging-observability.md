# Rule: Logging and Observability

Every significant operation must emit a structured log entry. Never use bare `console.log()` in module code.

Use the logger from `@aggregator-dpg/telemetry`. It wraps **pino** and emits structured JSON.

**Wire layer:** pino remains the application logging API. A custom pino
transport in `@aggregator-dpg/telemetry/pino-transport` forwards records to
the OTel `LoggerProvider`, which exports OTLP-logs to the Collector.
`trace_id` / `span_id` are auto-injected by the pino mixin in
`@aggregator-dpg/telemetry/logger` at log time on the main thread.

Required fields per log entry:

| Field        | Description                                             |
| ------------ | ------------------------------------------------------- |
| `operation`  | Name of the function or step                            |
| `status`     | `success`, `failure`, or `skipped`                      |
| `error`      | Error message and type (failure only)                   |
| `latency_ms` | Elapsed ms (external calls)                             |
| `timestamp`  | Epoch timestamp in millis (added automatically by pino) |

Log level is read from the `LOG_LEVEL` environment variable at startup (`debug` / `info` / `warn` / `error`). Default: `info`.

```typescript
import { logger } from '@aggregator-dpg/telemetry';

const start = Date.now();
// ... operation ...
logger.info({
  operation: 'signalStackClient.fetchMembers',
  status: 'success',
  latency_ms: Date.now() - start,
  aggregator_id: aggregatorId,
});

// On failure:
logger.error({
  operation: 'signalStackClient.fetchMembers',
  status: 'failure',
  error: err.message,
  error_type: err.constructor.name,
  latency_ms: Date.now() - start,
});
```

Differentiate levels:

- `logger.debug` — verbose internals, only visible at `LOG_LEVEL=debug`
- `logger.info` — normal operation milestones
- `logger.warn` — recoverable anomalies
- `logger.error` — failures requiring attention

Never log PII, phone numbers, or message content outside the designated audit log path managed by the Telemetry package.
