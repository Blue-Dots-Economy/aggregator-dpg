# `@aggregator-dpg/config-loader`

Loads configuration from disk for the aggregator services: environment resolution, consent
configuration, and Signals realm-role mappings.

## Subpath exports

| Subpath       | Contents                                                                            |
| ------------- | ----------------------------------------------------------------------------------- |
| `./interface` | `ConfigServiceBase` abstract class + types (`Env`, `ConfigSlice<S>`, `Unsubscribe`) |
| `./fs`        | `resolveEnv`, `loadConsentConfig`, `loadSignalsRealmRoles` — read YAML from disk    |
| `./testing`   | `ConfigServiceFake` — in-memory fake for unit tests                                 |
| `./config`    | The package's own `configKey` / `configSchema` / `configDefaults`                   |
| `./consent`   | Zod schema for the consent config document                                          |

## Usage

```typescript
import { loadConsentConfig, resolveEnv } from '@aggregator-dpg/config-loader/fs';

const env = resolveEnv(); // 'development' | 'staging' | 'production' | 'test'
const consent = await loadConsentConfig('blue_dot'); // optional brand + config root
```

```typescript
// In tests
import { ConfigServiceFake } from '@aggregator-dpg/config-loader/testing';

const config = new ConfigServiceFake({ signalStack: { baseUrl: 'http://localhost' } });
await config.load('test');
config.require<string>('signalStack.baseUrl'); // 'http://localhost'
```

## Config file conventions

- `packages/<name>/config.defaults.yaml` — default values, checked into repo
- `packages/<name>/src/config.schema.ts` — Zod schema validating the slice
- `config/env/{development,staging,production}.yaml` — per-env overrides (root of repo)

## Further reading

See [docs/config.md](../../docs/config.md) for the full precedence guide, secrets rules, and how to
add a new config key.
