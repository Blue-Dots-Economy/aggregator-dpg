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
