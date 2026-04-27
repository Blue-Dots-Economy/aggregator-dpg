# Configuration Guide

How the aggregator-dpg config system works, how to add a new key, and what is forbidden.

---

## Precedence (lowest → highest)

```
per-package configDefaults  (TypeScript, in packages/<name>/src/config.schema.ts)
        ↓  deep-merged by
packages/<name>/config.defaults.yaml
        ↓  deep-merged by
config/env/<env>.yaml        (YAML file, checked into repo, no secrets)
        ↓  interpolated by
${ENV_VAR} / ${ENV_VAR:-default}  (process.env at boot)
        ↓  validated by
Zod composite schema         (built from each package's configSchema)
```

Later layers override earlier ones. Objects are deep-merged; arrays are replaced wholesale.
Package `config.defaults.yaml` files may either contain the slice directly or nest it
under the package `configKey`.

---

## Environment selection

The loader resolves the active environment at boot:

```
CONFIG_ENV  →  NODE_ENV  →  "development"   (first defined wins)
```

Valid values: `development`, `staging`, `production`, `test`.

The resolved env determines which override file is loaded:

```
config/env/development.yaml
config/env/staging.yaml
config/env/production.yaml
config/env/test.yaml
```

Missing files are silently skipped (treated as empty).

---

## Env-var interpolation

Any YAML value may reference a process environment variable:

```yaml
# config/env/production.yaml
signalStack:
  baseUrl: ${SIGNALS_STACK_URL}
  apiKey: ${SIGNALS_STACK_API_KEY}
  timeout: ${SIGNALS_TIMEOUT_MS:-5000} # falls back to 5000 if unset
```

Rules:

- `${VAR}` — throws `CONFIG_ENV_VAR_MISSING` at boot if `VAR` is not set.
- `${VAR:-default}` — uses `default` when `VAR` is unset or empty.
- Interpolation runs **after** deep-merge but **before** Zod validation — Zod sees the final resolved value.
- Partial strings work: `"https://${HOST}/api"` resolves correctly.

---

## Secrets rules

**Never commit a secret value in any YAML file.** Config files are checked into the repo.

| ✅ Allowed in YAML           | ❌ Forbidden in YAML                  |
| ---------------------------- | ------------------------------------- |
| `apiKey: ${SIGNALS_API_KEY}` | `apiKey: sk-live-abc123`              |
| `dbUrl: ${DATABASE_URL}`     | `dbUrl: postgres://user:pass@host/db` |
| Non-secret defaults          | Tokens, passwords, private keys       |

Secrets live exclusively in environment variables, injected at deploy time (CI secrets, Vault, k8s Secrets, etc.).

---

## Hot-reload in development

Set `CONFIG_WATCH=1` before starting a service to enable filesystem watching:

```bash
CONFIG_WATCH=1 node dist/index.js
```

When active, `config/` is watched recursively. Any YAML change triggers a full reload after a 300 ms debounce. All `onChange()` listeners are notified on success. The previous config is preserved if the reload fails validation.

**Production:** `CONFIG_WATCH` is silently ignored. Config changes require a process restart.

Usage:

```typescript
import { FsConfigService } from '@aggregator-dpg/config-loader/fs';

const config = new FsConfigService();
await config.load('production');

// Optional: enable hot-reload (dev only, no-op in prod)
const stopWatching = config.watch();
config.onChange(() => {
  console.log('Config reloaded');
});

// On shutdown
stopWatching();
```

---

## Accessing config in a service

```typescript
import { FsConfigService } from '@aggregator-dpg/config-loader/fs';
import type { SignalStackConfig } from '@aggregator-dpg/signal-stack/config';

const config = new FsConfigService();
await config.load('production');

// Typed slice — throws CONFIG_KEY_MISSING if key absent
const ss = config.slice<SignalStackConfig>('signalStack');
console.log(ss.baseUrl); // fully typed

// Dotted path — returns undefined if missing
const url = config.get<string>('signalStack.baseUrl');

// Dotted path — throws if missing
const key = config.require<string>('signalStack.apiKey');
```

In tests, use `ConfigServiceFake` — no filesystem access needed:

```typescript
import { ConfigServiceFake } from '@aggregator-dpg/config-loader/testing';

const config = new ConfigServiceFake({
  signalStack: { baseUrl: 'http://localhost:3001' },
});
await config.load('test');
```

---

## How to add a new config key

Adding a key to an existing package takes four steps. No config-loader changes are needed.

### Step 1 — Extend the Zod schema

Edit `packages/<name>/src/config.schema.ts`:

```typescript
export const configSchema = z.object({
  baseUrl: z.string().url(),
  timeoutMs: z.number().int().positive(),
  newKey: z.string().min(1), // ← add here
});

export const configDefaults: Config = {
  baseUrl: 'http://localhost',
  timeoutMs: 5000,
  newKey: 'default-value', // ← add default
};
```

### Step 2 — Add the env-YAML entry (if env-specific)

Edit the relevant `config/env/<env>.yaml`:

```yaml
myPackage:
  newKey: ${MY_NEW_KEY:-default-value}
```

### Step 3 — Update the domain YAML (if it has one)

Edit the corresponding `config/<domain>.yaml` (e.g., `config/features.yaml`) if the key has a canonical file.

### Step 4 — Use `slice<T>()` to access

```typescript
const cfg = config.slice<MyPackageConfig>('myPackage');
console.log(cfg.newKey);
```

Zod validates the new key at boot — an invalid or missing value throws `ConfigError` with code `CONFIG_VALIDATION_ERROR` before the service accepts any traffic.

---

## Adding a new package

To introduce a new config namespace (e.g., `payments`):

1. Create `packages/payments/src/config.schema.ts` exporting `configKey`, `configSchema`, `configDefaults`.
2. Export the schema via the `./config` subpath in `packages/payments/package.json`.
3. `discoverPackages()` picks it up automatically at boot — no config-loader changes needed.
4. Link to this doc from `packages/payments/README.md`.

See `packages/_template/` for the canonical package layout.

---

## Troubleshooting

| Error code                | Cause                               | Fix                                             |
| ------------------------- | ----------------------------------- | ----------------------------------------------- |
| `CONFIG_PARSE_ERROR`      | YAML file is malformed              | Run `js-yaml` locally to validate the file      |
| `CONFIG_ENV_VAR_MISSING`  | `${VAR}` used but `VAR` not set     | Set the env var or add a `:-default` fallback   |
| `CONFIG_VALIDATION_ERROR` | Value doesn't match Zod schema      | Read the error — it lists every failing field   |
| `CONFIG_KEY_MISSING`      | `require()` or `slice()` key absent | Add the key to `configDefaults` or the env YAML |
| `CONFIG_NOT_LOADED`       | `reload()` called before `load()`   | Call `await config.load(env)` first             |
