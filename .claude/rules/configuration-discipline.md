# Rule: Configuration Discipline

No domain-specific or environment-specific value may be hardcoded in source code.

- API endpoints, thresholds, timeouts, feature flags, and service URLs must come from the `config-loader` package or environment variables.
- Source code may define defaults for optional parameters inside `config.defaults.yaml`, but anything that varies between deployments must be externally configurable.
- Read config once at startup via `@aggregator-dpg/config-loader`. Never re-read config files inside request paths.
- Per-environment overrides live in `config/env/{dev,staging,prod}.yaml`.

```typescript
// Wrong
const SIGNALS_STACK_URL = 'https://ubi-backend.onest.dhiway.net';
const OTP_EXPIRY_SECONDS = 300;

// Correct
const signalsUrl = config.get('signalStack.baseUrl');
const otpExpiry = config.get('auth.otpExpirySeconds');
```

## Named values

A literal that sets a limit, a size, a duration, a count or a business rule needs a name and a reason. Ask three questions before you write one:

1. **Can it differ by deployment, network, country or load?** Then it is configuration (see above), with a named default. External-call timeouts and retry counts are always configuration (`error-handling.md`).
2. **Is the same rule used in more than one place?** Then it is one exported constant or helper, imported everywhere. Business rules that the API, worker and web all apply (for example the age below which a participant is a minor) live in a shared package.
3. **Otherwise**, give it an `UPPER_CASE` constant next to the code that uses it, with a one-sentence TSDoc saying why it has that value.

- Do not leave a bare number in a condition, loop bound, `slice` length, timer or retry count.
- Keep the code and its comment in agreement. If the comment says "under 18", the code says `< 18`.
- Literals that need no name: `0`, `1`, `-1`, HTTP status codes, unit conversions (`1000` ms, `60` s, `1024` bytes), fixed formats (`toISOString().slice(0, 10)`, latitude ±90), and Zod limits inside a request or response schema (they are the API contract and are published in `openapi.json`).

```typescript
// Wrong
for (let depth = 0; cur && depth < 5; depth++) { /* ... */ }
const isMinor = age <= 18;
fetch(url, { signal: AbortSignal.timeout(5000) });

// Correct
/** Drizzle puts the driver error one level down; the rest is room for further wrapping. */
const MAX_CAUSE_DEPTH = 5;
for (let depth = 0; cur && depth < MAX_CAUSE_DEPTH; depth++) { /* ... */ }
const isMinor = isMinorAge(age); // one shared helper, used by the api, worker and web
fetch(url, { signal: AbortSignal.timeout(config.UPSTREAM_TIMEOUT_MS) });
```
