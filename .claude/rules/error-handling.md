# Rule: Error Handling

All calls to external systems (Signals Stack, Jobs Stack, Signal Processing Service, storage, email) must include:

- **Timeout** — explicit timeout on every external call; never rely on the default.
- **Retry** — retry transient failures (rate limits, timeouts) at least once with exponential backoff.
- **Structured errors** — throw a typed error class the caller can handle programmatically; never surface raw error strings to callers.
- **No silent swallowing** — never use empty `catch` blocks; always log and re-throw or return a structured failure.

```typescript
// Wrong
try {
  result = await callExternalApi();
} catch {
  // swallowed
}

// Correct
try {
  result = await callExternalApi();
} catch (err) {
  if (err instanceof TimeoutError) {
    logger.error('signals_stack_timeout', { operation: 'fetchMembers', error: String(err) });
    throw new UpstreamError('Signals Stack timed out', { cause: err });
  }
  throw err;
}
```

Use the typed error hierarchy from `@aggregator-dpg/shared-primitives`:
`BaseError` → `UpstreamError`, `ConfigError`, `AuthError`, `ValidationError`, `DomainError`.
